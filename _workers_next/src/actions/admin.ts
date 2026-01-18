'use server'

import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { products, cards, reviews, categories } from "@/lib/db/schema"
import { eq, sql, inArray, and, or, isNull, lte } from "drizzle-orm"
import { sendTelegramMessage } from "@/lib/notifications"
import { revalidatePath, revalidateTag } from "next/cache"
import { setSetting } from "@/lib/db/queries"

// Check Admin Helper
// Check Admin Helper
export async function checkAdmin() {
    const session = await auth()
    const user = session?.user
    const adminUsers = process.env.ADMIN_USERS?.toLowerCase().split(',') || []
    if (!user || !user.username || !adminUsers.includes(user.username.toLowerCase())) {
        throw new Error("Unauthorized")
    }
}

export async function saveProduct(formData: FormData) {
    await checkAdmin()

    const existingId = formData.get('id') as string
    const customSlug = (formData.get('slug') as string)?.trim()

    // Determine product ID
    let id: string
    if (existingId) {
        // Editing existing product - ALWAYS keep the original id (slug is read-only for existing products)
        id = existingId
    } else {
        // New product - use custom slug or generate
        id = customSlug || `prod_${Date.now()}`

        // Validate slug format for new products
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
            throw new Error("Slug can only contain letters, numbers, underscores and hyphens")
        }
    }

    const name = formData.get('name') as string
    const description = formData.get('description') as string
    const price = formData.get('price') as string
    const compareAtPrice = (formData.get('compareAtPrice') as string | null) || null
    const category = formData.get('category') as string
    const image = formData.get('image') as string
    const purchaseLimit = formData.get('purchaseLimit') ? parseInt(formData.get('purchaseLimit') as string) : null
    const isHot = formData.get('isHot') === 'on'
    const isShared = formData.get('isShared') === 'on'
    const purchaseWarning = (formData.get('purchaseWarning') as string | null)?.trim() || null

    const doSave = async () => {
        // Auto-create category if it doesn't exist
        if (category) {
            await ensureCategoriesTable()
            await db.run(sql`
                INSERT INTO categories (name, updated_at) 
                VALUES (${category}, (unixepoch() * 1000)) 
                ON CONFLICT (name) DO NOTHING
            `)
        }

        await db.insert(products).values({
            id,
            name,
            description,
            price,
            compareAtPrice: compareAtPrice && compareAtPrice !== '0' ? compareAtPrice : null,
            category,
            image,
            purchaseLimit,
            purchaseWarning,
            isHot,
            isShared
        }).onConflictDoUpdate({
            target: products.id,
            set: {
                name,
                description,
                price,
                compareAtPrice: compareAtPrice && compareAtPrice !== '0' ? compareAtPrice : null,
                category,
                image,
                purchaseLimit,
                purchaseWarning,
                isHot,
                isShared
            }
        })
    }

    // Ensure all product columns exist before saving
    const ensureColumns = async () => {
        try {
            await db.run(sql.raw(`ALTER TABLE products ADD COLUMN compare_at_price TEXT`));
        } catch { /* column exists */ }
        try {
            await db.run(sql.raw(`ALTER TABLE products ADD COLUMN is_hot INTEGER DEFAULT 0`));
        } catch { /* column exists */ }
        try {
            await db.run(sql.raw(`ALTER TABLE products ADD COLUMN purchase_warning TEXT`));
        } catch { /* column exists */ }
        try {
            await db.run(sql.raw(`ALTER TABLE products ADD COLUMN is_shared INTEGER DEFAULT 0`));
        } catch { /* column exists */ }
    }

    try {
        await doSave()
    } catch (error: any) {
        const errorString = JSON.stringify(error) + (error?.message || '')
        if (errorString.includes('42703') || errorString.includes('no such column') || errorString.includes('SQLITE_ERROR')) {
            await ensureColumns()
            await doSave()
        } else {
            throw error
        }
    }

    revalidatePath('/admin/products')
    revalidatePath('/admin/settings')
    revalidatePath('/')
    revalidateTag('home:products')
    revalidateTag('home:ratings')
    revalidateTag('home:categories')
}

export async function deleteProduct(id: string) {
    await checkAdmin()
    await db.delete(products).where(eq(products.id, id))
    revalidatePath('/admin/products')
    revalidatePath('/admin/settings')
    revalidatePath('/')
    revalidateTag('home:products')
    revalidateTag('home:ratings')
    revalidateTag('home:categories')
}

export async function toggleProductStatus(id: string, isActive: boolean) {
    await checkAdmin()
    await db.update(products).set({ isActive }).where(eq(products.id, id))
    revalidatePath('/admin/products')
    revalidatePath('/admin/settings')
    revalidatePath('/')
    revalidateTag('home:products')
}

export async function reorderProduct(id: string, newOrder: number) {
    await checkAdmin()
    await db.update(products).set({ sortOrder: newOrder }).where(eq(products.id, id))
    revalidatePath('/admin/products')
    revalidatePath('/admin/settings')
    revalidatePath('/')
    revalidateTag('home:products')
}

export async function addCards(formData: FormData) {
    await checkAdmin()
    const productId = formData.get('product_id') as string
    const rawCards = formData.get('cards') as string

    const cardList = rawCards
        .split(/[\n,]+/)
        .map(c => c.trim())
        .filter(c => c)

    if (cardList.length === 0) return

    try {
        await db.run(sql`DROP INDEX IF EXISTS cards_product_id_card_key_uq;`)
    } catch {
        // best effort
    }

    // D1 has a limit on SQL variables (around 100 bindings per query)
    // Drizzle generates bindings for all columns (~8), so 100/8 ≈ 12 max
    const BATCH_SIZE = 10
    for (let i = 0; i < cardList.length; i += BATCH_SIZE) {
        const batch = cardList.slice(i, i + BATCH_SIZE)
        await db.insert(cards).values(
            batch.map(key => ({
                productId,
                cardKey: key
            }))
        )
    }

    revalidatePath('/admin/products')
    revalidatePath('/admin/settings')
    revalidatePath(`/admin/cards/${productId}`)
    revalidatePath('/')
    revalidateTag('home:products')
}

export async function deleteCard(cardId: number) {
    await checkAdmin()

    // Only delete unused cards
    const card = await db.query.cards.findFirst({
        where: eq(cards.id, cardId)
    })

    if (!card) {
        throw new Error("Card not found")
    }

    if (card.isUsed) {
        throw new Error("Cannot delete used card")
    }
    if (card.reservedAt && card.reservedAt > new Date(Date.now() - 60 * 1000)) {
        throw new Error("Cannot delete reserved card")
    }

    await db.delete(cards).where(eq(cards.id, cardId))

    revalidatePath('/admin/products')
    revalidatePath('/admin/settings')
    revalidatePath('/admin/cards')
    revalidatePath('/')
    revalidateTag('home:products')
}

export async function deleteCards(cardIds: number[]) {
    await checkAdmin()

    if (!cardIds.length) return

    const BATCH_SIZE = 100
    for (let i = 0; i < cardIds.length; i += BATCH_SIZE) {
        const batch = cardIds.slice(i, i + BATCH_SIZE)

        await db.delete(cards)
            .where(
                and(
                    inArray(cards.id, batch),
                    or(isNull(cards.isUsed), eq(cards.isUsed, false)),
                    or(isNull(cards.reservedAt), lte(cards.reservedAt, new Date(Date.now() - 60 * 1000)))
                )
            )
    }

    revalidatePath('/admin/products')
    revalidatePath('/admin/settings')
    revalidatePath('/admin/cards')
    revalidatePath('/')
    revalidateTag('home:products')
}

export async function saveShopName(rawName: string) {
    await checkAdmin()

    const name = rawName.trim()
    if (!name) {
        throw new Error("Shop name cannot be empty")
    }
    if (name.length > 64) {
        throw new Error("Shop name is too long")
    }

    try {
        await setSetting('shop_name', name)
    } catch (error: any) {
        // If settings table doesn't exist, create it and retry
        if (error.message?.includes('does not exist') ||
            error.code === '42P01' ||
            JSON.stringify(error).includes('42P01')) {
            await db.run(sql`
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at INTEGER DEFAULT (unixepoch() * 1000)
                )
            `)
            await setSetting('shop_name', name)
        } else {
            throw error
        }
    }

    revalidatePath('/')
    revalidatePath('/admin/products')
    revalidatePath('/admin/settings')
    revalidateTag('home:products')
}

export async function saveShopDescription(rawDesc: string) {
    await checkAdmin()

    const desc = rawDesc.trim()
    if (desc.length > 200) {
        throw new Error("Description is too long")
    }

    await setSetting('shop_description', desc)
    revalidatePath('/')
    revalidatePath('/admin/products')
    revalidatePath('/admin/settings')
    revalidateTag('home:products')
}

export async function saveShopLogo(logoUrl: string) {
    await checkAdmin()

    const url = logoUrl.trim()
    if (url && url.length > 500) {
        throw new Error("Logo URL is too long")
    }

    await setSetting('shop_logo', url)
    revalidatePath('/')
    revalidatePath('/admin/products')
    revalidatePath('/admin/settings')
    revalidatePath('/admin/settings')
    revalidateTag('home:products')
}

export async function deleteReview(reviewId: number) {
    await checkAdmin()
    await db.delete(reviews).where(eq(reviews.id, reviewId))
    revalidatePath('/admin/reviews')
    revalidateTag('home:ratings')
    revalidatePath('/')
}

export async function saveLowStockThreshold(raw: string) {
    await checkAdmin()
    const n = Number.parseInt(String(raw || '').trim(), 10)
    const value = Number.isFinite(n) && n > 0 ? String(n) : '5'
    await setSetting('low_stock_threshold', value)
    revalidatePath('/admin/products')
    revalidatePath('/admin/settings')
    revalidateTag('home:products')
}

export async function saveCheckinReward(raw: string) {
    await checkAdmin()
    const n = Number.parseInt(String(raw || '').trim(), 10)
    const value = Number.isFinite(n) && n > 0 ? String(n) : '10'
    await setSetting('checkin_reward', value)
    revalidatePath('/admin/products')
    revalidatePath('/admin/settings')
    revalidateTag('home:products')
}

export async function saveCheckinEnabled(enabled: boolean) {
    await checkAdmin()
    await setSetting('checkin_enabled', enabled ? 'true' : 'false')
    revalidatePath('/admin/products')
    revalidatePath('/admin/settings')
    revalidatePath('/')
    revalidateTag('home:products')
}

export async function saveNoIndex(enabled: boolean) {
    await checkAdmin()
    await setSetting('noindex_enabled', enabled ? 'true' : 'false')
    revalidatePath('/admin/products')
    revalidatePath('/admin/settings')
    revalidatePath('/')
    revalidateTag('home:products')
}

export async function saveShopFooter(footer: string) {
    await checkAdmin()

    const text = footer.trim()
    if (text.length > 500) {
        throw new Error("Footer text is too long")
    }

    await setSetting('shop_footer', text)
    revalidatePath('/admin/settings')
    revalidatePath('/')
    revalidateTag('home:products')
}

const VALID_THEME_COLORS = ['purple', 'blue', 'cyan', 'green', 'orange', 'pink', 'red']

export async function saveThemeColor(color: string) {
    await checkAdmin()

    if (!VALID_THEME_COLORS.includes(color)) {
        throw new Error("Invalid theme color")
    }

    await setSetting('theme_color', color)
    revalidatePath('/admin/settings')
    revalidatePath('/')
    revalidateTag('home:products')
}

export async function saveNotificationSettings(formData: FormData) {
    await checkAdmin()

    const token = (formData.get('telegramBotToken') as string || '').trim()
    const chatId = (formData.get('telegramChatId') as string || '').trim()
    const language = (formData.get('telegramLanguage') as string || 'zh').trim()

    await setSetting('telegram_bot_token', token)
    await setSetting('telegram_chat_id', chatId)
    await setSetting('telegram_language', language)

    // Email settings
    const resendApiKey = (formData.get('resendApiKey') as string || '').trim()
    const resendFromEmail = (formData.get('resendFromEmail') as string || '').trim()
    const resendFromName = (formData.get('resendFromName') as string || '').trim()
    const resendEnabled = formData.get('resendEnabled') === 'true'

    await setSetting('resend_api_key', resendApiKey)
    await setSetting('resend_from_email', resendFromEmail)
    await setSetting('resend_from_name', resendFromName)
    await setSetting('resend_enabled', resendEnabled ? 'true' : 'false')

    revalidatePath('/admin/notifications')
}

export async function testNotification() {
    await checkAdmin()
    return await sendTelegramMessage("🔔 Test notification from LDC Shop")
}

export async function testEmailNotification(to: string) {
    await checkAdmin()
    const { testResendEmail } = await import("@/lib/email")
    return await testResendEmail(to)
}

async function ensureCategoriesTable() {
    await db.run(sql`
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            icon TEXT,
            sort_order INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (unixepoch() * 1000),
            updated_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS categories_name_uq ON categories(name);
    `)
}

export async function saveCategory(formData: FormData) {
    await checkAdmin()
    await ensureCategoriesTable()

    const idRaw = formData.get('id') as string | null
    const name = String(formData.get('name') || '').trim()
    const icon = String(formData.get('icon') || '').trim() || null
    const sortOrder = Number.parseInt(String(formData.get('sortOrder') || '0'), 10) || 0
    if (!name) throw new Error("Category name is required")

    if (idRaw) {
        const id = Number.parseInt(idRaw, 10)
        await db.update(categories).set({ name, icon, sortOrder, updatedAt: new Date() }).where(eq(categories.id, id))
    } else {
        await db.insert(categories).values({ name, icon, sortOrder, updatedAt: new Date() })
    }

    revalidatePath('/admin/categories')
    revalidatePath('/')
    revalidateTag('home:categories')
    revalidateTag('home:products')
}

export async function deleteCategory(id: number) {
    await checkAdmin()
    await ensureCategoriesTable()
    await db.delete(categories).where(eq(categories.id, id))
    revalidatePath('/admin/categories')
    revalidatePath('/')
    revalidateTag('home:categories')
    revalidateTag('home:products')
}
