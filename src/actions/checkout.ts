'use server'

import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { products, cards, orders } from "@/lib/db/schema"
import { cancelExpiredOrders } from "@/lib/db/queries"
import { generateOrderId, generateSign } from "@/lib/crypto"
import { eq, sql, and, or } from "drizzle-orm"
import { cookies } from "next/headers"

export async function createOrder(productId: string, email?: string) {
    const session = await auth()
    const user = session?.user

    // 1. Get Product
    const product = await db.query.products.findFirst({
        where: eq(products.id, productId)
    })
    if (!product) return { success: false, error: 'buy.productNotFound' }

    try {
        await cancelExpiredOrders({ productId })
    } catch {
        // Best effort cleanup
    }

    const ensureCardsReservationColumns = async () => {
        await db.execute(sql`
            ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_order_id TEXT;
            ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMP;
        `);
    }

    const ensureCardsIsUsedDefaults = async () => {
        // Best effort: handle legacy schemas where is_used has no default and existing rows are NULL
        await db.execute(sql`
            ALTER TABLE cards ALTER COLUMN is_used SET DEFAULT FALSE;
            UPDATE cards SET is_used = FALSE WHERE is_used IS NULL;
        `);
    }

    const getAvailableStock = async () => {
        const result = await db.select({ count: sql<number>`count(*)::int` })
            .from(cards)
            .where(sql`
                ${cards.productId} = ${productId}
                AND (COALESCE(${cards.isUsed}, false) = false)
                AND (${cards.reservedAt} IS NULL OR ${cards.reservedAt} < NOW() - INTERVAL '1 minute')
            `)
        return result[0]?.count || 0
    }

    // 2. Check Stock
    let stock = 0
    try {
        stock = await getAvailableStock()
    } catch (error: any) {
        const errorString = JSON.stringify(error)
        const isMissingColumn =
            error?.message?.includes('reserved_order_id') ||
            error?.message?.includes('reserved_at') ||
            errorString.includes('42703')

        if (isMissingColumn) {
            await ensureCardsReservationColumns()
            stock = await getAvailableStock()
        } else {
            throw error
        }
    }

    if (stock <= 0) {
        // If legacy schema inserted NULL is_used, try backfill once and re-check.
        try {
            const nullUsed = await db.select({ count: sql<number>`count(*)::int` })
                .from(cards)
                .where(sql`${cards.productId} = ${productId} AND ${cards.isUsed} IS NULL`)
            if ((nullUsed[0]?.count || 0) > 0) {
                await ensureCardsIsUsedDefaults()
                stock = await getAvailableStock()
            }
        } catch {
            // ignore
        }
    }

    if (stock <= 0) return { success: false, error: 'buy.outOfStock' }

    // 3. Check Purchase Limit
    if (product.purchaseLimit && product.purchaseLimit > 0) {
        const currentUserId = user?.id
        const currentUserEmail = email || user?.email

        if (currentUserId || currentUserEmail) {
            const conditions = [eq(orders.productId, productId)]
            const userConditions = []

            if (currentUserId) userConditions.push(eq(orders.userId, currentUserId))
            if (currentUserEmail) userConditions.push(eq(orders.email, currentUserEmail))

            if (userConditions.length > 0) {
                const countResult = await db.select({ count: sql<number>`count(*)::int` })
                    .from(orders)
                    .where(and(
                        eq(orders.productId, productId),
                        or(...userConditions),
                        or(eq(orders.status, 'paid'), eq(orders.status, 'delivered'))
                    ))

                const existingCount = countResult[0]?.count || 0
                if (existingCount >= product.purchaseLimit) {
                    return { success: false, error: 'buy.limitExceeded' }
                }
            }
        }
    }

    // 4. Create Order + Reserve Stock (1 minute)
    const orderId = generateOrderId()

    const reserveAndCreate = async () => {
        await db.transaction(async (tx) => {
            const reservedResult = await tx.execute(sql`
                UPDATE cards
                SET reserved_order_id = ${orderId}, reserved_at = NOW()
                WHERE id = (
                    SELECT id
                    FROM cards
                    WHERE product_id = ${productId}
                      AND COALESCE(is_used, false) = false
                      AND (reserved_at IS NULL OR reserved_at < NOW() - INTERVAL '1 minute')
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                )
                RETURNING id
            `);

            if (!reservedResult.rows.length) {
                throw new Error('stock_locked');
            }

            await tx.insert(orders).values({
                orderId,
                productId: product.id,
                productName: product.name,
                amount: product.price,
                email: email || user?.email || null,
                userId: user?.id || null,
                username: user?.username || null,
                status: 'pending'
            });
        });
    };

    try {
        await reserveAndCreate();
    } catch (error: any) {
        if (error?.message === 'stock_locked') {
            return { success: false, error: 'buy.stockLocked' };
        }

        const errorString = JSON.stringify(error);
        const isMissingColumn =
            error?.message?.includes('reserved_order_id') ||
            error?.message?.includes('reserved_at') ||
            errorString.includes('42703'); // undefined_column

        if (isMissingColumn) {
            await db.execute(sql`
                ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_order_id TEXT;
                ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMP;
            `);

            try {
                await reserveAndCreate();
            } catch (retryError: any) {
                if (retryError?.message === 'stock_locked') {
                    return { success: false, error: 'buy.stockLocked' };
                }
                throw retryError;
            }
        } else {
            throw error;
        }
    }

    // Set Pending Cookie
    const cookieStore = await cookies()
    cookieStore.set('ldc_pending_order', orderId, { secure: true, path: '/', sameSite: 'lax' })

    // 4. Generate Pay Params
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
    const payParams: Record<string, any> = {
        pid: process.env.MERCHANT_ID!,
        type: 'epay',
        out_trade_no: orderId,
        notify_url: `${baseUrl}/api/notify`,
        return_url: `${baseUrl}/callback/${orderId}`, // Use path-based param to avoid query string stripping
        name: product.name,
        money: Number(product.price).toFixed(2),
        sign_type: 'MD5'
    }

    payParams.sign = generateSign(payParams, process.env.MERCHANT_KEY!)

    return {
        success: true,
        url: process.env.PAY_URL || 'https://credit.linux.do/epay/pay/submit.php',
        params: payParams
    }
}
