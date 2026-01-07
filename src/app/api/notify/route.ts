import { db } from "@/lib/db";
import { orders, cards } from "@/lib/db/schema";
import { md5 } from "@/lib/crypto";
import { eq, sql } from "drizzle-orm";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function processNotify(params: Record<string, any>) {
    console.log("[Notify] Processing params:", JSON.stringify(params));

    // Verify Sign
    const sign = params.sign;
    const sorted = Object.keys(params)
        .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] !== null && params[k] !== undefined)
        .sort()
        .map(k => `${k}=${params[k]}`)
        .join('&');

    const mySign = md5(`${sorted}${process.env.MERCHANT_KEY}`);

    console.log("[Notify] Signature check - received:", sign, "computed:", mySign);

    if (sign !== mySign) {
        console.log("[Notify] Signature mismatch!");
        return new Response('fail', { status: 400 });
    }

    console.log("[Notify] Signature verified OK. trade_status:", params.trade_status);

    if (params.trade_status === 'TRADE_SUCCESS') {
        const orderId = params.out_trade_no;
        const tradeNo = params.trade_no;

        console.log("[Notify] Processing order:", orderId);

        // Find Order
        const order = await db.query.orders.findFirst({
            where: eq(orders.orderId, orderId)
        });

        console.log("[Notify] Order found:", order ? "YES" : "NO", "status:", order?.status);

        if (order) {
            // Verify Amount (Prevent penny-dropping)
            const notifyMoney = parseFloat(params.money);
            const orderMoney = parseFloat(order.amount);

            // Allow small float epsilon difference
            if (Math.abs(notifyMoney - orderMoney) > 0.01) {
                console.error(`[Notify] Amount mismatch! Order: ${orderMoney}, Notify: ${notifyMoney}`);
                return new Response('fail', { status: 400 });
            }

            if (order.status === 'pending' || order.status === 'cancelled') {
                await db.transaction(async (tx) => {
                    // Atomic update to claim card (Postgres only)
                    // Finds the first unused card, locks it, and marks it as used
                    let cardKey: string | undefined;
                    let supportsReservation = true;

                    try {
                        const reservedResult = await tx.execute(sql`
                            UPDATE cards
                            SET is_used = true,
                                used_at = NOW(),
                                reserved_order_id = NULL,
                                reserved_at = NULL
                            WHERE reserved_order_id = ${orderId} AND COALESCE(is_used, false) = false
                            RETURNING card_key
                        `);

                        cardKey = reservedResult.rows[0]?.card_key as string | undefined;
                    } catch (error: any) {
                        const errorString = JSON.stringify(error);
                        if (
                            error?.message?.includes('reserved_order_id') ||
                            error?.message?.includes('reserved_at') ||
                            errorString.includes('42703')
                        ) {
                            supportsReservation = false;
                        } else {
                            throw error;
                        }
                    }

                    if (!cardKey) {
                        if (supportsReservation) {
                            const result = await tx.execute(sql`
                                UPDATE cards
                                SET is_used = true,
                                    used_at = NOW(),
                                    reserved_order_id = NULL,
                                    reserved_at = NULL
                                WHERE id = (
                                    SELECT id
                                    FROM cards
                                    WHERE product_id = ${order.productId}
                                      AND COALESCE(is_used, false) = false
                                      AND (reserved_at IS NULL OR reserved_at < NOW() - INTERVAL '1 minute')
                                    LIMIT 1
                                    FOR UPDATE SKIP LOCKED
                                )
                                RETURNING card_key
                            `);

                            cardKey = result.rows[0]?.card_key as string | undefined;
                        } else {
                            const result = await tx.execute(sql`
                                UPDATE cards
                                SET is_used = true, used_at = NOW()
                                WHERE id = (
                                    SELECT id
                                    FROM cards
                                    WHERE product_id = ${order.productId} AND COALESCE(is_used, false) = false
                                    LIMIT 1
                                    FOR UPDATE SKIP LOCKED
                                )
                                RETURNING card_key
                            `);

                            cardKey = result.rows[0]?.card_key as string | undefined;
                        }
                    }

                    console.log("[Notify] Card claimed:", cardKey ? "YES" : "NO");

                    if (cardKey) {
                        await tx.update(orders)
                            .set({
                                status: 'delivered',
                                paidAt: new Date(),
                                deliveredAt: new Date(),
                                tradeNo: tradeNo,
                                cardKey: cardKey
                            })
                            .where(eq(orders.orderId, orderId));
                        console.log("[Notify] Order delivered successfully!");
                    } else {
                        // Paid but no stock
                        await tx.update(orders)
                            .set({ status: 'paid', paidAt: new Date(), tradeNo: tradeNo })
                            .where(eq(orders.orderId, orderId));
                        console.log("[Notify] Order marked as paid (no stock)");
                    }
                });
            }
        }
    }

    return new Response('success');
}

// Handle GET requests (Linux DO Credit sends GET)
export async function GET(request: Request) {
    console.log("[Notify] Received GET callback");

    try {
        const url = new URL(request.url);
        const params: Record<string, any> = {};
        url.searchParams.forEach((value, key) => {
            params[key] = value;
        });

        return await processNotify(params);
    } catch (e) {
        console.error("[Notify] Error:", e);
        return new Response('error', { status: 500 });
    }
}

// Also handle POST requests for compatibility
export async function POST(request: Request) {
    console.log("[Notify] Received POST callback");

    try {
        const formData = await request.formData();
        const params: Record<string, any> = {};
        formData.forEach((value, key) => {
            params[key] = value;
        });

        return await processNotify(params);
    } catch (e) {
        console.error("[Notify] Error:", e);
        return new Response('error', { status: 500 });
    }
}
