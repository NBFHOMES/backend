import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { createClient } from "@supabase/supabase-js";

// --- Supabase Setup ---
const SUPABASE_URL = "https://ndoafecuiyxxybynwanf.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5kb2FmZWN1aXl4eHlieW53YW5mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQzMjI3NjcsImV4cCI6MjA3OTg5ODc2N30.X4fXt3ZoSCXi_Caf0LlJlreZjniVFWjKxTZ0214Lky8";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- Types (Mirroring Frontend Types) ---
interface Money {
  amount: string;
  currencyCode: string;
}

interface Image {
  url: string;
  altText: string;
  width?: number;
  height?: number;
}

interface Product {
  id: string;
  handle: string;
  title: string;
  description: string;
  priceRange: {
    minVariantPrice: Money;
    maxVariantPrice: Money;
  };
  currencyCode: string;
  seo: {
    title: string;
    description: string;
  };
  featuredImage: Image;
  images: Image[];
  options: { id: string; name: string; values: string[] }[];
  variants: {
    id: string;
    title: string;
    price: Money;
    availableForSale: boolean;
    selectedOptions: { name: string; value: string }[];
  }[];
  tags: string[];
  availableForSale: boolean;
  userId?: string; // Added userId
  contactNumber?: string;
  categoryId?: string;
}

interface Collection {
  id: string;
  handle: string;
  title: string;
  description: string;
  path: string;
  updatedAt: string;
}

// --- Helper to map DB result to Product ---
const mapPropertyToProduct = (prop: any): Product => ({
  id: prop.id,
  handle: prop.handle,
  title: prop.title,
  description: prop.description,
  priceRange: prop.price_range,
  currencyCode: prop.currency_code,
  seo: prop.seo,
  featuredImage: prop.featured_image,
  images: prop.images,
  options: prop.options,
  variants: prop.variants,
  tags: prop.tags,
  availableForSale: prop.available_for_sale,
  userId: prop.user_id,
  contactNumber: prop.contact_number,
  categoryId: prop.category_id
});

// --- Helper to map DB result to Collection ---
const mapDbCollectionToCollection = (col: any): Collection => ({
  id: col.id,
  handle: col.handle,
  title: col.title,
  description: col.description,
  path: col.path,
  updatedAt: col.updated_at,
});

// --- Security: Rate Limiter ---
const rateLimit = new Map<string, { count: number, lastReset: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS = 100; // 100 requests per minute

const checkRateLimit = (headers: Headers) => {
  // Get IP from Render/Cloudflare headers or fallback
  const ip = headers.get('cf-connecting-ip') ||
    headers.get('x-forwarded-for') ||
    'unknown';

  const now = Date.now();
  const record = rateLimit.get(ip) || { count: 0, lastReset: now };

  if (now - record.lastReset > RATE_LIMIT_WINDOW) {
    record.count = 0;
    record.lastReset = now;
  }

  record.count++;
  rateLimit.set(ip, record);

  if (record.count > MAX_REQUESTS) {
    console.warn(`Rate limit exceeded for IP: ${ip}`);
    throw new Error("Security Alert: Too many requests. Please try again later.");
  }
};

// --- Security: Input Sanitization ---
const sanitizeInput = (str: string) => {
  if (typeof str !== 'string') return str;
  // Remove potential script tags and dangerous characters
  return str
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gm, "")
    .replace(/[<>'"]/g, (tag) => {
      const chars: Record<string, string> = {
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      };
      return chars[tag] || tag;
    });
};

// --- Auth Helper (Enhanced) ---
const verifyAuth = async (headers: Record<string, string | undefined>) => {
  const authHeader = headers['authorization'] || headers['Authorization'];
  if (!authHeader) throw new Error('Unauthorized: Missing token');

  const token = authHeader.replace('Bearer ', '');

  // 1. Verify Token Integrity
  if (!token || token.split('.').length !== 3) {
    throw new Error('Security Alert: Malformed token detected');
  }

  // 2. Verify with Supabase
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) throw new Error('Unauthorized: Invalid token');
  return user;
};

// --- Server ---

const app = new Elysia()
  .use(cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:3001",
      "https://nbfhomes.com",
      "https://www.nbfhomes.com",
      "https://www.nbfhomes.in"
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-user-id"],
    credentials: true
  }))
  // Global Security Middleware
  .onBeforeHandle(({ request }) => {
    checkRateLimit(request.headers);
  })

  // 1. Get All Products (Properties) - Support both GET and POST
  .get("/products", async () => {
    const { data, error } = await supabase.from("properties").select("*").eq('available_for_sale', true);
    if (error) throw error;
    return data.map(mapPropertyToProduct);
  })
  .post("/products", async ({ body }) => {
    console.log('POST /products body:', body);
    const { query, limit, sortKey, reverse } = body;

    let dbQuery = supabase.from("properties").select("*");

    if (query) {
      // Simple search implementation
      const { data, error } = await supabase
        .from("properties")
        .select("*")
        .eq('available_for_sale', true)
        .or(`title.ilike.%${query}%,description.ilike.%${query}%`)
        .limit(limit || 100); // Apply limit to search too

      if (error) throw error;
      return data.map(mapPropertyToProduct);
    }

    // Apply sorting
    if (sortKey === 'PRICE') {
      dbQuery = dbQuery.order('price_range->minVariantPrice->amount', { ascending: !reverse });
    } else if (sortKey === 'CREATED_AT') {
      dbQuery = dbQuery.order('created_at', { ascending: !reverse });
    } else {
      // Default sort
      dbQuery = dbQuery.order('id', { ascending: false });
    }

    // Apply limit
    if (limit) {
      dbQuery = dbQuery.limit(limit);
    }

    const { data, error } = await dbQuery.eq('available_for_sale', true);
    if (error) throw error;
    return data.map(mapPropertyToProduct);
  }, {
    body: t.Object({
      query: t.Optional(t.String()),
      sortKey: t.Optional(t.String()),
      reverse: t.Optional(t.Boolean()),
      limit: t.Optional(t.Number())
    })
  })

  // 2. Get Single Product
  .get("/products/:handle", async ({ params: { handle } }) => {
    const { data, error } = await supabase
      .from("properties")
      .select("*")
      .eq("handle", handle)
      .eq('available_for_sale', true)
      .single();

    if (error || !data) return { error: "Product not found" };
    return mapPropertyToProduct(data);
  })

  // Get User's Properties
  .get("/products/user/:userId", async ({ params: { userId } }) => {
    const { data, error } = await supabase
      .from("properties")
      .select("*")
      .eq("user_id", userId);

    if (error) throw error;
    return data.map(mapPropertyToProduct);
  })

  // 3. Get Collections (Categories)
  .get("/collections", async () => {
    const { data, error } = await supabase.from("collections").select("*");
    if (error) throw error;
    return data.map(mapDbCollectionToCollection);
  })

  // 4. Get Single Collection
  .get("/collections/:handle", async ({ params: { handle } }) => {
    const { data, error } = await supabase
      .from("collections")
      .select("*")
      .eq("handle", handle)
      .single();

    if (error || !data) return { error: "Collection not found" };
    return mapDbCollectionToCollection(data);
  })

  // 5. Get Collection Products - Support both GET and POST
  .get("/collections/:handle/products", async ({ params: { handle } }) => {
    let filter = "";
    if (handle === 'pgs') filter = "PG";
    if (handle === 'flats') filter = "Flat"; // Simplified logic
    if (handle === 'private-rooms') filter = "Room";

    let query = supabase.from("properties").select("*").eq('available_for_sale', true);

    if (filter) {
      query = query.ilike("title", `%${filter}%`);
    }

    // Special handling for 'flats' to include '1BHK' as per original mock logic
    if (handle === 'flats') {
      const { data, error } = await supabase.from("properties").select("*").eq('available_for_sale', true).or("title.ilike.%Flat%,title.ilike.%1BHK%");
      if (error) throw error;
      return data.map(mapPropertyToProduct);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data.map(mapPropertyToProduct);
  })
  .post("/collections/:handle/products", async ({ params: { handle } }) => {
    // Reusing the same logic as GET for now
    let filter = "";
    if (handle === 'pgs') filter = "PG";
    if (handle === 'flats') filter = "Flat";
    if (handle === 'private-rooms') filter = "Room";

    if (handle === 'flats') {
      const { data, error } = await supabase.from("properties").select("*").or("title.ilike.%Flat%,title.ilike.%1BHK%");
      if (error) throw error;
      return data.map(mapPropertyToProduct);
    }

    let query = supabase.from("properties").select("*").eq('available_for_sale', true);
    if (filter) {
      query = query.ilike("title", `%${filter}%`);
    }
    const { data, error } = await query;
    if (error) throw error;
    return data.map(mapPropertyToProduct);
  })

  // 7. Create Product (Post Property)
  .post("/products/create", async ({ body, headers }) => {
    const user = await verifyAuth(headers);
    console.log('POST /products/create body:', body);
    const { title, description, price, address, location, type, imageUrl, contactNumber } = body as any;

    // Sanitize inputs
    const cleanTitle = sanitizeInput(title);
    const cleanDescription = sanitizeInput(description);

    const handle = cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const id = `prop_${Date.now()}`;

    const newProperty = {
      id,
      handle,
      title: cleanTitle,
      description: cleanDescription,
      category_id: address,
      currency_code: "INR",
      seo: { title: cleanTitle, description: cleanDescription },
      featured_image: {
        url: imageUrl,
        altText: cleanTitle,
        width: 800,
        height: 600,
      },
      images: [
        {
          url: imageUrl,
          altText: title,
          width: 800,
          height: 600,
        }
      ],
      options: [],
      variants: [
        {
          id: `var_${Date.now()}`,
          title: "Default Title",
          price: { amount: price, currencyCode: "INR" },
          availableForSale: true,
          selectedOptions: [],
        }
      ],
      tags: [type, location, "New Listing"],
      available_for_sale: true,
      price_range: {
        minVariantPrice: { amount: price, currencyCode: "INR" },
        maxVariantPrice: { amount: price, currencyCode: "INR" },
      },
      user_id: user.id, // Use authenticated user ID
      contact_number: contactNumber
    };

    const { data, error } = await supabase
      .from("properties")
      .insert([newProperty])
      .select()
      .single();

    if (error) {
      console.error("Error creating property:", error);
      throw error;
    }

    return mapPropertyToProduct(data);
  })

  // 8. Update Product (Edit Property)
  .put("/products/:id", async ({ params: { id }, body, headers }) => {
    const user = await verifyAuth(headers);
    const { title, description, price, address, location, type, imageUrl, contactNumber } = body as any;

    // Sanitize inputs
    const cleanTitle = sanitizeInput(title);
    const cleanDescription = sanitizeInput(description);

    const updates: any = {
      title: cleanTitle,
      description: cleanDescription,
      category_id: address,
      featured_image: {
        url: imageUrl,
        altText: cleanTitle,
        width: 800,
        height: 600,
      },
      images: [{
        url: imageUrl,
        altText: title,
        width: 800,
        height: 600,
      }],
      tags: [type, location, "New Listing"],
      price_range: {
        minVariantPrice: { amount: price, currencyCode: "INR" },
        maxVariantPrice: { amount: price, currencyCode: "INR" },
      },
      variants: [{
        id: `var_${Date.now()}`,
        title: "Default Title",
        price: { amount: price, currencyCode: "INR" },
        availableForSale: true,
        selectedOptions: [],
      }],
      seo: { title, description },
      contact_number: contactNumber
    };

    const { data, error } = await supabase
      .from("properties")
      .update(updates)
      .eq("id", id)
      .eq("user_id", user.id) // Ensure ownership
      .select()
      .single();

    if (error) throw error;
    if (!data) throw new Error("Property not found or unauthorized");
    return mapPropertyToProduct(data);
  })

  // 9. Delete Product (Delete Property)
  .delete("/products/:id", async ({ params: { id }, headers }) => {
    const user = await verifyAuth(headers);
    const { error, count } = await supabase
      .from("properties")
      .delete({ count: 'exact' })
      .eq("id", id)
      .eq("user_id", user.id); // Ensure ownership

    if (error) throw error;
    if (count === 0) throw new Error("Property not found or unauthorized");
    return { success: true, message: "Property deleted" };
  })

  // Admin Stats
  .get("/admin/stats", async () => {
    const { count: total } = await supabase.from("properties").select("*", { count: 'exact', head: true });
    const { count: active } = await supabase.from("properties").select("*", { count: 'exact', head: true }).eq('available_for_sale', true);

    const { data: users } = await supabase.from("properties").select("user_id");
    const uniqueUsers = new Set(users?.map(u => u.user_id).filter(Boolean)).size;

    return { total: total || 0, active: active || 0, users: uniqueUsers };
  })

  // Admin Paginated Products with Search & Filter
  .get("/admin/products", async ({ query: { page = '1', limit = '10', search = '', status = 'all' } }) => {
    const p = parseInt(page);
    const l = parseInt(limit);
    const start = (p - 1) * l;
    const end = start + l - 1;

    let query = supabase
      .from("properties")
      .select("*", { count: 'exact' });

    if (search) {
      query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%,contact_number.ilike.%${search}%`);
    }

    if (status !== 'all') {
      query = query.eq('available_for_sale', status === 'active');
    }

    const { data, count, error } = await query
      .range(start, end)
      .order('id', { ascending: false });

    if (error) throw error;
    return {
      products: data.map(mapPropertyToProduct),
      total: count || 0,
      page: p,
      limit: l
    };
  }, {
    query: t.Object({
      page: t.Optional(t.String()),
      limit: t.Optional(t.String()),
      search: t.Optional(t.String()),
      status: t.Optional(t.String())
    })
  })

  // Admin Toggle Status
  .patch("/admin/products/:id/status", async ({ params: { id }, body, headers }) => {
    const adminUserId = headers['x-admin-user-id'];
    if (!adminUserId) throw new Error('Unauthorized');

    // Verify admin
    const { data: adminCheck } = await supabase
      .from("admin_users")
      .select("user_id")
      .eq("user_id", adminUserId)
      .single();

    if (!adminCheck) throw new Error('Unauthorized');

    const { availableForSale } = body as { availableForSale: boolean };

    const { data, error } = await supabase
      .from("properties")
      .update({ available_for_sale: availableForSale })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    return mapPropertyToProduct(data);
  })

  // Admin Get Users (Aggregated from Properties)
  .get("/admin/users", async ({ query: { page = '1', limit = '10' } }) => {
    const p = parseInt(page);
    const l = parseInt(limit);

    // Fetch all properties to aggregate users (since we don't have direct access to auth.users)
    // In a real app with many users, this should be an RPC or a separate table query
    const { data: properties, error } = await supabase
      .from("properties")
      .select("user_id, contact_number, available_for_sale");

    if (error) throw error;

    const userMap = new Map<string, { userId: string; contactNumber: string; totalProperties: number; activeProperties: number }>();

    properties.forEach((prop: any) => {
      if (!prop.user_id) return;

      if (!userMap.has(prop.user_id)) {
        userMap.set(prop.user_id, {
          userId: prop.user_id,
          contactNumber: prop.contact_number || 'N/A',
          totalProperties: 0,
          activeProperties: 0
        });
      }

      const user = userMap.get(prop.user_id)!;
      user.totalProperties++;
      if (prop.available_for_sale) {
        user.activeProperties++;
      }
      // Update contact number if available and current is N/A
      if (user.contactNumber === 'N/A' && prop.contact_number) {
        user.contactNumber = prop.contact_number;
      }
    });

    const allUsers = Array.from(userMap.values());
    const total = allUsers.length;

    // Pagination
    const start = (p - 1) * l;
    const end = start + l;
    const paginatedUsers = allUsers.slice(start, end);

    return {
      users: paginatedUsers,
      total,
      page: p,
      limit: l
    };
  }, {
    query: t.Object({
      page: t.Optional(t.String()),
      limit: t.Optional(t.String())
    })
  })

  // 10. Check if user is admin (with security)
  .get("/admin/check/:userId", async ({ params: { userId }, headers }) => {
    // Verify request is from same origin
    const origin = headers.origin || headers.referer;
    if (!origin || !origin.includes('localhost')) {
      return { isAdmin: false, error: 'Invalid origin' };
    }

    // Check if userId is valid UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      return { isAdmin: false, error: 'Invalid user ID' };
    }

    try {
      const { data, error } = await supabase
        .from("admin_users")
        .select("user_id")
        .eq("user_id", userId)
        .single();

      return { isAdmin: !!data && !error };
    } catch {
      return { isAdmin: false };
    }
  })

  // 11. Admin-only delete endpoint (protected)
  .delete("/admin/products/:id", async ({ params: { id }, headers }) => {
    const adminUserId = headers['x-admin-user-id'];

    if (!adminUserId) {
      throw new Error('Unauthorized');
    }

    // Verify admin status
    const { data: adminCheck } = await supabase
      .from("admin_users")
      .select("user_id")
      .eq("user_id", adminUserId)
      .single();

    if (!adminCheck) {
      throw new Error('Unauthorized: Admin access required');
    }

    // Delete property
    const { error } = await supabase
      .from("properties")
      .delete()
      .eq("id", id);

    if (error) throw error;
    return { success: true, message: "Property deleted by admin" };
  })

  // 6. Cart (Mock for now to prevent errors)
  .get("/cart/:id", () => ({
    id: "cart_mock",
    lines: [],
    cost: { subtotalAmount: { amount: "0", currencyCode: "INR" }, totalAmount: { amount: "0", currencyCode: "INR" } },
    totalQuantity: 0
  }))
  .post("/cart", () => ({
    id: "cart_mock",
    lines: [],
    cost: { subtotalAmount: { amount: "0", currencyCode: "INR" }, totalAmount: { amount: "0", currencyCode: "INR" } },
    totalQuantity: 0
  }))

  .listen(Number(process.env.PORT) || 4000);

console.log(`🦊 Server running on port ${Number(process.env.PORT) || 4000}`);

console.log(
  `🦊 Property API is running at ${app.server?.hostname}:${app.server?.port}`
);
