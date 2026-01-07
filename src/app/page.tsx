import { getActiveProducts, getCategories, getProductRating, getVisitorCount } from "@/lib/db/queries";
import { getActiveAnnouncement } from "@/actions/settings";
import { HomeContent } from "@/components/home-content";

export const dynamic = 'force-dynamic';

export default async function Home() {
  let products: any[] = [];
  try {
    products = await getActiveProducts();
  } catch (error: any) {
    const errorString = JSON.stringify(error);
    const isTableMissing =
      error.message?.includes('does not exist') ||
      error.cause?.message?.includes('does not exist') ||
      errorString.includes('42P01') || // PostgreSQL error code for undefined_table
      errorString.includes('relation') && errorString.includes('does not exist');

    if (isTableMissing) {
      console.log("Database initialized check: Table missing. Running inline migrations...");
      const { db } = await import("@/lib/db");
      const { sql } = await import("drizzle-orm");

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          price DECIMAL(10, 2) NOT NULL,
          compare_at_price DECIMAL(10, 2),
          category TEXT,
          image TEXT,
          is_hot BOOLEAN DEFAULT FALSE,
          is_active BOOLEAN DEFAULT TRUE,
          sort_order INTEGER DEFAULT 0,
          purchase_limit INTEGER,
          created_at TIMESTAMP DEFAULT NOW()
        );
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
        CREATE TABLE IF NOT EXISTS orders (
          order_id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL,
          product_name TEXT NOT NULL,
          amount DECIMAL(10, 2) NOT NULL,
          email TEXT,
          status TEXT DEFAULT 'pending',
          trade_no TEXT,
          card_key TEXT,
          paid_at TIMESTAMP,
          delivered_at TIMESTAMP,
          user_id TEXT,
          username TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS login_users (
          user_id TEXT PRIMARY KEY,
          username TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          last_login_at TIMESTAMP DEFAULT NOW()
        );
        -- Add columns if missing (for existing databases)
        ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_limit INTEGER;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS compare_at_price DECIMAL(10, 2);
        ALTER TABLE products ADD COLUMN IF NOT EXISTS is_hot BOOLEAN DEFAULT FALSE;
        ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_order_id TEXT;
        ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMP;
        ALTER TABLE cards ALTER COLUMN is_used SET DEFAULT FALSE;
        UPDATE cards SET is_used = FALSE WHERE is_used IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS cards_product_id_card_key_uq ON cards(product_id, card_key);
        -- Settings table for announcements
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at TIMESTAMP DEFAULT NOW()
        );
        -- Categories table
        CREATE TABLE IF NOT EXISTS categories (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          icon TEXT,
          sort_order INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS categories_name_uq ON categories(name);
        -- Reviews table
        CREATE TABLE IF NOT EXISTS reviews (
          id SERIAL PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          order_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          rating INTEGER NOT NULL,
          comment TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        );
        -- Refund requests
        CREATE TABLE IF NOT EXISTS refund_requests (
          id SERIAL PRIMARY KEY,
          order_id TEXT NOT NULL,
          user_id TEXT,
          username TEXT,
          reason TEXT,
          status TEXT DEFAULT 'pending',
          admin_username TEXT,
          admin_note TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          processed_at TIMESTAMP
        );
      `);

      products = await getActiveProducts();
    } else {
      throw error;
    }
  }

  const announcement = await getActiveAnnouncement();

  // Fetch ratings for each product
  const productsWithRatings = await Promise.all(
    products.map(async (p) => {
      let rating = { average: 0, count: 0 };
      try {
        rating = await getProductRating(p.id);
      } catch {
        // Reviews table might not exist yet
      }
      return {
        ...p,
        stockCount: p.stock,
        soldCount: p.sold || 0,
        rating: rating.average,
        reviewCount: rating.count
      };
    })
  );

  let visitorCount = 0;
  try {
    visitorCount = await getVisitorCount();
  } catch {
    visitorCount = 0;
  }

  let categories: any[] = []
  try {
    categories = await getCategories()
  } catch {
    categories = []
  }

  return <HomeContent
    products={productsWithRatings}
    announcement={announcement}
    visitorCount={visitorCount}
    categories={categories}
  />;
}
