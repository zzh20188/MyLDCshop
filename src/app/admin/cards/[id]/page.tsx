import { db } from "@/lib/db"
import { cards } from "@/lib/db/schema"
import { desc, sql } from "drizzle-orm"
import { getProduct } from "@/lib/db/queries"
import { notFound } from "next/navigation"
import { CardsContent } from "@/components/admin/cards-content"

export default async function CardsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const product = await getProduct(id)
    if (!product) return notFound()

    // Get Unused Cards
    let unusedCards: any[] = []
    try {
        unusedCards = await db.select()
            .from(cards)
            .where(sql`${cards.productId} = ${id} AND COALESCE(${cards.isUsed}, false) = false AND (${cards.reservedAt} IS NULL OR ${cards.reservedAt} < NOW() - INTERVAL '1 minute')`)
            .orderBy(desc(cards.createdAt))
    } catch (error: any) {
        const errorString = JSON.stringify(error)
        const isTableOrColumnMissing =
            error?.message?.includes('does not exist') ||
            error?.cause?.message?.includes('does not exist') ||
            errorString.includes('42P01') || // undefined_table
            errorString.includes('42703') || // undefined_column
            (errorString.includes('relation') && errorString.includes('does not exist'))

        if (!isTableOrColumnMissing) throw error

        await db.execute(sql`
            CREATE TABLE IF NOT EXISTS cards (
                id SERIAL PRIMARY KEY,
                product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                card_key TEXT NOT NULL,
                is_used BOOLEAN DEFAULT FALSE,
                reserved_order_id TEXT,
                reserved_at TIMESTAMP,
                used_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW()
            );
            ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_order_id TEXT;
            ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMP;
        `)

        unusedCards = await db.select()
            .from(cards)
            .where(sql`${cards.productId} = ${id} AND COALESCE(${cards.isUsed}, false) = false AND (${cards.reservedAt} IS NULL OR ${cards.reservedAt} < NOW() - INTERVAL '1 minute')`)
            .orderBy(desc(cards.createdAt))
    }

    return (
        <CardsContent
            productId={id}
            productName={product.name}
            unusedCards={unusedCards.map(c => ({ id: c.id, cardKey: c.cardKey }))}
        />
    )
}
