import { getActiveProducts, getCategories, getProductRatings, getVisitorCount, getUserPendingOrders } from "@/lib/db/queries";
import { getActiveAnnouncement } from "@/actions/settings";
import { auth } from "@/lib/auth";
import { HomeContent } from "@/components/home-content";
import { unstable_cache } from "next/cache";

const CACHE_TTL_SECONDS = 30;
const TAG_PRODUCTS = "home:products";
const TAG_RATINGS = "home:ratings";
const TAG_ANNOUNCEMENT = "home:announcement";
const TAG_VISITORS = "home:visitors";
const TAG_CATEGORIES = "home:categories";

const getCachedActiveProducts = unstable_cache(
  async () => getActiveProducts(),
  ["active-products"],
  { revalidate: CACHE_TTL_SECONDS, tags: [TAG_PRODUCTS] }
);

const getCachedAnnouncement = unstable_cache(
  async () => getActiveAnnouncement(),
  ["active-announcement"],
  { revalidate: CACHE_TTL_SECONDS, tags: [TAG_ANNOUNCEMENT] }
);

const getCachedVisitorCount = unstable_cache(
  async () => getVisitorCount(),
  ["visitor-count"],
  { revalidate: CACHE_TTL_SECONDS, tags: [TAG_VISITORS] }
);

const getCachedCategories = unstable_cache(
  async () => getCategories(),
  ["categories"],
  { revalidate: CACHE_TTL_SECONDS, tags: [TAG_CATEGORIES] }
);

export default async function Home() {
  // Run all independent queries in parallel for better performance
  const [session, productsResult, announcement, visitorCount, categories] = await Promise.all([
    auth(),
    getCachedActiveProducts().catch(() => []),
    getCachedAnnouncement().catch(() => null),
    getCachedVisitorCount().catch(() => 0),
    getCachedCategories().catch(() => [])
  ]);

  const products = productsResult;

  const productIds = products.map((p: any) => p.id).filter(Boolean);
  const sortedIds = [...productIds].sort();
  let ratingsMap = new Map<string, { average: number; count: number }>();
  try {
    ratingsMap = await unstable_cache(
      async () => getProductRatings(sortedIds),
      ["product-ratings", ...sortedIds],
      { revalidate: CACHE_TTL_SECONDS, tags: [TAG_RATINGS] }
    )();
  } catch {
    // Reviews table might not exist yet
  }

  const productsWithRatings = products.map((p: any) => {
    const rating = ratingsMap.get(p.id) || { average: 0, count: 0 };
    return {
      ...p,
      stockCount: p.stock + (p.locked || 0),
      soldCount: p.sold || 0,
      rating: rating.average,
      reviewCount: rating.count
    };
  });

  // Check for pending orders (depends on session)
  let pendingOrders: any[] = [];
  if (session?.user?.id) {
    try {
      pendingOrders = await getUserPendingOrders(session.user.id);
    } catch {
      // Ignore errors fetching pending orders
    }
  }

  return <HomeContent
    products={productsWithRatings}
    announcement={announcement}
    visitorCount={visitorCount}
    categories={categories}
    pendingOrders={pendingOrders}
  />;
}
