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

// --- In-Memory Cache (Redis-like functionality) ---
const cache = new Map<string, { data: any, expiry: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes default TTL

const cacheGet = (key: string) => {
  const item = cache.get(key);
  if (item && Date.now() < item.expiry) {
    return item.data;
  } else if (item) {
    cache.delete(key); // Clean up expired items
  }
  return null;
};

const cacheSet = (key: string, data: any, ttl: number = CACHE_TTL) => {
  cache.set(key, { data, expiry: Date.now() + ttl });
};

const cacheDelete = (key: string) => {
  cache.delete(key);
};

// --- Security: Rate Limiter ---
const rateLimit = new Map<string, { count: number, lastReset: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
// Different rate limits for different endpoints
const RATE_LIMITS = {
  general: { maxRequests: 100, window: RATE_LIMIT_WINDOW }, // General requests
  auth: { maxRequests: 10, window: RATE_LIMIT_WINDOW },     // Auth endpoints
  create: { maxRequests: 5, window: RATE_LIMIT_WINDOW }     // Property creation
};

const checkRateLimit = (headers: Headers, endpointType: 'general' | 'auth' | 'create' = 'general') => {
  // Get IP from Render/Cloudflare headers or fallback
  const forwardedFor = headers.get('x-forwarded-for');
  let ip = headers.get('cf-connecting-ip') ||
    (forwardedFor ? forwardedFor.split(',')[0] : '') ||
    headers.get('x-real-ip') ||
    'unknown';

  // Validate IP format to prevent bypass attempts
  if (ip === 'unknown' || !isValidIP(ip)) {
    // Use a generic identifier for unknown IPs to prevent resource exhaustion
    ip = 'unknown';
  }

  const limitConfig = RATE_LIMITS[endpointType];
  const now = Date.now();
  const record = rateLimit.get(ip) || { count: 0, lastReset: now };

  if (now - record.lastReset > limitConfig.window) {
    record.count = 0;
    record.lastReset = now;
  }

  record.count++;
  rateLimit.set(ip, record);

  if (record.count > limitConfig.maxRequests) {
    console.warn(`Rate limit exceeded for IP: ${ip} on ${endpointType} endpoint`);
    throw new Error("Security Alert: Too many requests. Please try again later.");
  }
};

// Validate IP address format
const isValidIP = (ip: string): boolean => {
  // Basic IPv4 validation
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4Regex.test(ip)) {
    return ip.split('.').every(octet => parseInt(octet, 10) <= 255);
  }
  // Basic IPv6 validation
  const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  if (ipv6Regex.test(ip)) {
    return true;
  }
  return false;
};

// --- Security: Input Sanitization ---
const sanitizeInput = (input: any): any => {
  if (typeof input === 'string') {
    // Remove potential script tags and dangerous characters
    let sanitized = input
      .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, "")
      .replace(/<iframe\b[^>]*>([\s\S]*?)<\/iframe>/gi, "")
      .replace(/<object\b[^>]*>([\s\S]*?)<\/object>/gi, "")
      .replace(/<embed\b[^>]*>/gi, "")
      .replace(/<form\b[^>]*>([\s\S]*?)<\/form>/gi, "")
      .replace(/javascript:/gi, "")
      .replace(/vbscript:/gi, "")
      .replace(/data:/gi, "")
      .replace(/on\w+\s*=/gi, "")
      .replace(/<[^>]*>/g, (tag) => {
        // Allow only safe HTML tags if needed
        const safeTags = ['br', 'p', 'strong', 'em', 'ul', 'ol', 'li'];
        const tagMatch = tag.match(/<\/?([a-zA-Z]+)/);
        if (tagMatch && safeTags.includes(tagMatch[1].toLowerCase())) {
          return tag;
        }
        return ''; // Remove dangerous HTML tags
      })
      .replace(/[<>'"]/g, (char) => {
        const chars: Record<string, string> = {
          '<': '&lt;',
          '>': '&gt;',
          "'": '&#39;',
          '"': '&quot;'
        };
        return chars[char] || char;
      });

    // Additional XSS prevention - limit string length
    if (sanitized.length > 1000) {
      sanitized = sanitized.substring(0, 1000);
    }

    return sanitized;
  } else if (Array.isArray(input)) {
    return input.map(sanitizeInput);
  } else if (typeof input === 'object' && input !== null) {
    const sanitizedObj: any = {};
    for (const key in input) {
      if (input.hasOwnProperty(key)) {
        sanitizedObj[sanitizeInput(key)] = sanitizeInput(input[key]);
      }
    }
    return sanitizedObj;
  }
  return input;
};

// --- Security: Validate Input Types ---
const validateInput = (input: any, type: 'string' | 'number' | 'email' | 'url' | 'uuid' | 'boolean' | 'array'): boolean => {
  switch (type) {
    case 'string':
      return typeof input === 'string' && input.length <= 1000;
    case 'number':
      return typeof input === 'number' && !isNaN(input) && isFinite(input);
    case 'email':
      const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
      return typeof input === 'string' && emailRegex.test(input) && input.length <= 254;
    case 'url':
      try {
        new URL(input);
        return true;
      } catch {
        return false;
      }
    case 'uuid':
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      return typeof input === 'string' && uuidRegex.test(input);
    case 'boolean':
      return typeof input === 'boolean';
    case 'array':
      return Array.isArray(input);
    default:
      return true;
  }
};

// --- Security: CSRF Protection ---
// In a real application, you would store CSRF tokens in a secure database
// For this implementation, we'll use a simple in-memory store (not suitable for production)
const csrfTokens = new Map<string, { token: string; userId: string; createdAt: number }>();

const generateCSRFToken = (userId: string): string => {
  const token = crypto.randomUUID();
  const tokenId = crypto.randomUUID();

  // Store the token with user ID and creation time
  csrfTokens.set(tokenId, {
    token,
    userId,
    createdAt: Date.now()
  });

  // Clean up expired tokens (older than 24 hours)
  cleanupExpiredCSRF();

  return `${tokenId}.${token}`;
};

const validateCSRFToken = (token: string, userId: string): boolean => {
  if (!token || typeof token !== 'string') {
    return false;
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return false;
  }

  const [tokenId, tokenValue] = parts;
  const storedToken = csrfTokens.get(tokenId);

  if (!storedToken) {
    return false;
  }

  // Verify token matches and hasn't expired (24 hours) and user matches
  const isExpired = Date.now() - storedToken.createdAt > 24 * 60 * 60 * 1000; // 24 hours

  if (isExpired) {
    csrfTokens.delete(tokenId);
    return false;
  }

  // Check if the token matches and the user ID matches
  const isValid = storedToken.token === tokenValue && storedToken.userId === userId;

  if (isValid) {
    // Remove the token after use to prevent replay attacks (for sensitive operations)
    csrfTokens.delete(tokenId);
  }

  return isValid;
};

const cleanupExpiredCSRF = () => {
  const now = Date.now();
  for (const [tokenId, storedToken] of csrfTokens.entries()) {
    if (now - storedToken.createdAt > 24 * 60 * 60 * 1000) { // 24 hours
      csrfTokens.delete(tokenId);
    }
  }
};

// --- Security: JWT Token Validation Helper ---
const verifyAuth = async (headers: Record<string, string | undefined>) => {
  const authHeader = headers['authorization'] || headers['Authorization'];
  if (!authHeader) throw new Error('Unauthorized: Missing token');

  const token = authHeader.replace('Bearer ', '').trim();

  // 1. Verify Token Integrity
  if (!token || token.split('.').length !== 3) {
    throw new Error('Security Alert: Malformed token detected');
  }

  // 2. Check for token in blacklist (in a real app, this would be a Redis/DB check)
  // For now, we'll rely on Supabase's built-in verification
  const decodedToken = parseJWT(token);
  if (!decodedToken) {
    throw new Error('Security Alert: Invalid token format');
  }

  // 3. Check token expiration
  const now = Math.floor(Date.now() / 1000);
  if (decodedToken.exp && decodedToken.exp < now) {
    throw new Error('Unauthorized: Token expired');
  }

  // 4. Verify with Supabase
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    console.error('Auth verification failed:', error);
    throw new Error('Unauthorized: Invalid token');
  }

  // 5. Additional security check - ensure user exists in our system
  // (Optional: Check if user is active/verified in your business logic)
  const { data: existingUser, error: userCheckError } = await supabase
    .from('users') // Assuming you have a users table
    .select('id, status')
    .eq('id', user.id)
    .single();

  if (userCheckError) {
    // If the user doesn't exist in your system but exists in Supabase,
    // you might want to create them or deny access
    // For now, we'll proceed with Supabase user
    console.warn('User not found in local DB, proceeding with Supabase auth:', userCheckError);
  } else if (existingUser && existingUser.status === 'suspended') {
    throw new Error('Unauthorized: Account suspended');
  }

  return user;
};

// Parse JWT token to extract payload (without verification - for validation purposes only)
const parseJWT = (token: string) => {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch (e) {
    console.error('Error parsing JWT:', e);
    return null;
  }
};

// -- Security: Admin Authorization Helper ---
const verifyAdmin = async (headers: Record<string, string | undefined>) => {
  const adminUserId = headers['x-admin-user-id'] || headers['X-Admin-User-Id'];
  if (!adminUserId) throw new Error('Unauthorized: Missing admin user ID');

  // Validate UUID format
  if (!validateInput(adminUserId, 'uuid')) {
    throw new Error('Security Alert: Invalid admin user ID format');
  }

  // Check if user is an admin in the database
  const { data: adminCheck, error } = await supabase
    .from("admin_users")
    .select("user_id")
    .eq("user_id", adminUserId)
    .single();

  if (error || !adminCheck) {
    console.error('Admin verification failed:', error);
    throw new Error('Unauthorized: Admin access required');
  }

  return adminCheck;
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
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-user-id", "X-Requested-With", "X-Client-Type", "X-CSRF-Token"],
    credentials: true,
    // Additional security options
    exposeHeaders: ["X-Total-Count", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
    maxAge: 86400, // 24 hours

  }))
  // Security Headers Middleware
  .onBeforeHandle(({ set }) => {
    // Set security headers
    set.headers['X-Content-Type-Options'] = 'nosniff';
    set.headers['X-Frame-Options'] = 'DENY'; // or 'SAMEORIGIN' if you need iframes from same origin
    set.headers['X-XSS-Protection'] = '1; mode=block';
    set.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
    set.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
    set.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.google-analytics.com https://www.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' https:; connect-src 'self' https://*.supabase.co https://www.google-analytics.com; frame-ancestors 'none'; object-src 'none';";
  })
  // Global Security Middleware
  .onBeforeHandle(({ request, path }) => {
    // Different rate limits based on endpoint
    let endpointType: 'general' | 'auth' | 'create' = 'general';
    if (path.includes('/products/create')) {
      endpointType = 'create';
    } else if (path.includes('/auth') || path.match(/\/login|\/register|\/auth/)) {
      endpointType = 'auth';
    }
    checkRateLimit(request.headers, endpointType);
  })

  // 1. Get All Products (Properties) - Support both GET and POST
  .get("/products", async () => {
    // Use cache for this expensive operation
    const cacheKey = 'all_properties';
    const cached = cacheGet(cacheKey);
    if (cached) {
      return cached;
    }

    const { data, error } = await supabase.from("properties").select("*").eq('available_for_sale', true);
    if (error) throw error;

    const result = data.map(mapPropertyToProduct);
    cacheSet(cacheKey, result, 10 * 60 * 1000); // Cache for 10 minutes

    return result;
  })
  .post("/products", async ({ body }) => {
    console.log('POST /products body:', body);

    // Validate and sanitize inputs - enhanced with advanced filtering
    let { query, limit, sortKey, reverse, minPrice, maxPrice, location, propertyType, amenities } = body;

    if (query && validateInput(query, 'string')) {
      query = sanitizeInput(query);
    } else if (query) {
      throw new Error("Security Alert: Invalid query parameter");
    }

    if (limit !== undefined) {
      if (!validateInput(limit, 'number') || limit < 1 || limit > 1000) {
        throw new Error("Security Alert: Invalid limit parameter");
      }
      limit = Math.floor(limit); // Ensure it's an integer
    }

    if (sortKey && !['PRICE', 'CREATED_AT', 'RELEVANCE'].includes(sortKey)) {
      throw new Error("Security Alert: Invalid sortKey parameter");
    }

    if (reverse !== undefined && !validateInput(reverse, 'boolean')) {
      throw new Error("Security Alert: Invalid reverse parameter");
    }

    // Validate numeric filters
    if (minPrice !== undefined && (!validateInput(parseFloat(minPrice), 'number') || parseFloat(minPrice) < 0)) {
      throw new Error("Security Alert: Invalid minPrice parameter");
    }

    if (maxPrice !== undefined && (!validateInput(parseFloat(maxPrice), 'number') || parseFloat(maxPrice) < 0)) {
      throw new Error("Security Alert: Invalid maxPrice parameter");
    }

    if (location !== undefined && !validateInput(location, 'string')) {
      throw new Error("Security Alert: Invalid location parameter");
    }

    if (propertyType !== undefined && !['PG', 'Flat', 'Room', 'Hostel', '1BHK', '2BHK', '3BHK'].includes(propertyType)) {
      throw new Error("Security Alert: Invalid propertyType parameter");
    }

    if (amenities !== undefined && !Array.isArray(amenities)) {
      throw new Error("Security Alert: Invalid amenities parameter");
    }

    let dbQuery = supabase.from("properties").select("*");

    // Apply base filter
    dbQuery = dbQuery.eq('available_for_sale', true);

    // Apply search and filtering
    if (query) {
      // Use full-text search if available, otherwise fallback to ilike
      dbQuery = dbQuery.or(`title.ilike.%${sanitizeInput(query)}%,description.ilike.%${sanitizeInput(query)}%`);
    }

    // Apply price range filter
    if (minPrice !== undefined) {
      dbQuery = dbQuery.gte('price_range->minVariantPrice->amount', parseFloat(minPrice).toString());
    }
    if (maxPrice !== undefined) {
      dbQuery = dbQuery.lte('price_range->minVariantPrice->amount', parseFloat(maxPrice).toString());
    }

    // Apply location filter (using tags)
    if (location) {
      dbQuery = dbQuery.ilike('tags', `%${sanitizeInput(location)}%`);
    }

    // Apply property type filter (using tags)
    if (propertyType) {
      dbQuery = dbQuery.ilike('tags', `%${sanitizeInput(propertyType)}%`);
    }

    // Apply amenities filter (if stored in tags or a separate field)
    if (amenities && Array.isArray(amenities)) {
      for (const amenity of amenities) {
        if (validateInput(amenity, 'string')) {
          dbQuery = dbQuery.ilike('tags', `%${sanitizeInput(amenity)}%`);
        }
      }
    }

    // Apply limit
    if (limit) {
      dbQuery = dbQuery.limit(limit);
    }

    // Apply sorting
    if (sortKey === 'PRICE') {
      dbQuery = dbQuery.order('price_range->minVariantPrice->amount', { ascending: !reverse });
    } else if (sortKey === 'CREATED_AT') {
      dbQuery = dbQuery.order('created_at', { ascending: !reverse });
    } else if (sortKey === 'RELEVANCE' && query) {
      // For relevance, we'll order by ID (newest) when searching
      dbQuery = dbQuery.order('id', { ascending: false });
    } else {
      // Default sort
      dbQuery = dbQuery.order('id', { ascending: false });
    }

    const { data, error } = await dbQuery;
    if (error) throw error;
    return data.map(mapPropertyToProduct);
  }, {
    body: t.Object({
      query: t.Optional(t.String()),
      sortKey: t.Optional(t.String()),
      reverse: t.Optional(t.Boolean()),
      limit: t.Optional(t.Number()),
      minPrice: t.Optional(t.String()),
      maxPrice: t.Optional(t.String()),
      location: t.Optional(t.String()),
      propertyType: t.Optional(t.String()),
      amenities: t.Optional(t.Array(t.String()))
    })
  })

  // 2. Get Single Product
  .get("/products/:handle", async ({ params: { handle } }) => {
    // Validate handle parameter
    if (!handle || !validateInput(handle, 'string') || handle.length > 200) {
      throw new Error("Security Alert: Invalid handle parameter");
    }

    const sanitizedHandle = sanitizeInput(handle);

    // Use cache for this operation
    const cacheKey = `product_${sanitizedHandle}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      return cached;
    }

    const { data, error } = await supabase
      .from("properties")
      .select("*")
      .eq("handle", sanitizedHandle)
      .eq('available_for_sale', true)
      .single();

    if (error || !data) return { error: "Product not found" };

    const result = mapPropertyToProduct(data);
    cacheSet(cacheKey, result, 15 * 60 * 1000); // Cache for 15 minutes

    return result;
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
    // Use cache for this operation
    const cacheKey = 'collections';
    const cached = cacheGet(cacheKey);
    if (cached) {
      return cached;
    }

    const { data, error } = await supabase.from("collections").select("*");
    if (error) throw error;

    const result = data.map(mapDbCollectionToCollection);
    cacheSet(cacheKey, result, 30 * 60 * 1000); // Cache for 30 minutes

    return result;
  })

  // 4. Get Single Collection
  .get("/collections/:handle", async ({ params: { handle } }) => {
    // Validate handle parameter
    if (!handle || !validateInput(handle, 'string') || handle.length > 200) {
      throw new Error("Security Alert: Invalid handle parameter");
    }

    const sanitizedHandle = sanitizeInput(handle);

    // Use cache for this operation
    const cacheKey = `collection_${sanitizedHandle}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      return cached;
    }

    const { data, error } = await supabase
      .from("collections")
      .select("*")
      .eq("handle", sanitizedHandle)
      .single();

    if (error || !data) return { error: "Collection not found" };

    const result = mapDbCollectionToCollection(data);
    cacheSet(cacheKey, result, 30 * 60 * 1000); // Cache for 30 minutes

    return result;
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

    // CSRF Token validation
    const csrfToken = headers['x-csrf-token'] || headers['X-CSRF-Token'];
    if (!csrfToken || !validateCSRFToken(csrfToken as string, user.id)) {
      throw new Error("Security Alert: Invalid or missing CSRF token");
    }

    // Validate and sanitize inputs
    const { title, description, price, address, location, type, images, contactNumber } = body as any;

    // Input validation
    if (!title || !validateInput(title, 'string') || title.length < 3 || title.length > 200) {
      throw new Error("Security Alert: Invalid title parameter");
    }

    if (!description || !validateInput(description, 'string') || description.length > 5000) {
      throw new Error("Security Alert: Invalid description parameter");
    }

    if (!price || !validateInput(parseFloat(price), 'number') || parseFloat(price) <= 0) {
      throw new Error("Security Alert: Invalid price parameter");
    }

    if (!address || !validateInput(address, 'string') || address.length > 500) {
      throw new Error("Security Alert: Invalid address parameter");
    }

    if (!location || !validateInput(location, 'string') || location.length > 200) {
      throw new Error("Security Alert: Invalid location parameter");
    }

    if (!type || !['PG', 'Flat', 'Room', 'Hostel'].includes(type)) {
      throw new Error("Security Alert: Invalid property type parameter");
    }

    if (!images || !Array.isArray(images) || images.length === 0 || !images.every((url: string) => validateInput(url, 'url'))) {
      throw new Error("Security Alert: Invalid images parameter");
    }

    if (!contactNumber || !validateInput(contactNumber, 'string') || contactNumber.length > 20) {
      throw new Error("Security Alert: Invalid contact number parameter");
    }

    // Sanitize inputs
    const cleanTitle = sanitizeInput(title);
    const cleanDescription = sanitizeInput(description);
    const cleanAddress = sanitizeInput(address);
    const cleanLocation = sanitizeInput(location);
    const cleanType = sanitizeInput(type);
    const cleanImages = images.map((url: string) => sanitizeInput(url));
    const cleanContactNumber = sanitizeInput(contactNumber);

    const handle = cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const id = `prop_${Date.now()}`;

    const newProperty = {
      id,
      handle,
      title: cleanTitle,
      description: cleanDescription,
      category_id: cleanAddress,
      currency_code: "INR",
      seo: { title: cleanTitle, description: cleanDescription },
      featured_image: {
        url: cleanImages[0],
        altText: cleanTitle,
        width: 800,
        height: 600,
      },
      images: cleanImages.map((url: string) => ({
        url,
        altText: cleanTitle,
        width: 800,
        height: 600,
      })),
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
      tags: [cleanType, cleanLocation, "New Listing"],
      available_for_sale: true,
      price_range: {
        minVariantPrice: { amount: price, currencyCode: "INR" },
        maxVariantPrice: { amount: price, currencyCode: "INR" },
      },
      user_id: user.id,
      contact_number: cleanContactNumber
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
  }, {
    body: t.Object({
      title: t.String(),
      description: t.String(),
      price: t.String(),
      address: t.String(),
      location: t.String(),
      type: t.String(),
      images: t.Array(t.String()),
      contactNumber: t.String()
    })
  })

  // 8. Update Product (Edit Property)
  .put("/products/:id", async ({ params: { id }, body, headers }) => {
    const user = await verifyAuth(headers);

    // CSRF Token validation
    const csrfToken = headers['x-csrf-token'] || headers['X-CSRF-Token'];
    if (!csrfToken || !validateCSRFToken(csrfToken as string, user.id)) {
      throw new Error("Security Alert: Invalid or missing CSRF token");
    }

    // Validate and sanitize inputs
    const { title, description, price, address, location, type, images, contactNumber } = body as any;

    // Input validation
    if (!title || !validateInput(title, 'string') || title.length < 3 || title.length > 200) {
      throw new Error("Security Alert: Invalid title parameter");
    }

    if (!description || !validateInput(description, 'string') || description.length > 5000) {
      throw new Error("Security Alert: Invalid description parameter");
    }

    if (!price || !validateInput(parseFloat(price), 'number') || parseFloat(price) <= 0) {
      throw new Error("Security Alert: Invalid price parameter");
    }

    if (!address || !validateInput(address, 'string') || address.length > 500) {
      throw new Error("Security Alert: Invalid address parameter");
    }

    if (!location || !validateInput(location, 'string') || location.length > 200) {
      throw new Error("Security Alert: Invalid location parameter");
    }

    if (!type || !['PG', 'Flat', 'Room', 'Hostel'].includes(type)) {
      throw new Error("Security Alert: Invalid property type parameter");
    }

    if (!images || !Array.isArray(images) || images.length === 0 || !images.every((url: string) => validateInput(url, 'url'))) {
      throw new Error("Security Alert: Invalid images parameter");
    }

    if (!contactNumber || !validateInput(contactNumber, 'string') || contactNumber.length > 20) {
      throw new Error("Security Alert: Invalid contact number parameter");
    }

    // Sanitize inputs
    const cleanTitle = sanitizeInput(title);
    const cleanDescription = sanitizeInput(description);
    const cleanAddress = sanitizeInput(address);
    const cleanLocation = sanitizeInput(location);
    const cleanType = sanitizeInput(type);
    const cleanImages = images.map((url: string) => sanitizeInput(url));
    const cleanContactNumber = sanitizeInput(contactNumber);

    const updates: any = {
      title: cleanTitle,
      description: cleanDescription,
      category_id: cleanAddress,
      featured_image: {
        url: cleanImages[0],
        altText: cleanTitle,
        width: 800,
        height: 600,
      },
      images: cleanImages.map((url: string) => ({
        url,
        altText: cleanTitle,
        width: 800,
        height: 600,
      })),
      tags: [cleanType, cleanLocation, "New Listing"],
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
      seo: { title: cleanTitle, description: cleanDescription },
      contact_number: cleanContactNumber
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
  }, {
    body: t.Object({
      title: t.String(),
      description: t.String(),
      price: t.String(),
      address: t.String(),
      location: t.String(),
      type: t.String(),
      images: t.Array(t.String()),
      contactNumber: t.String()
    })
  })

  // 9. Delete Product (Delete Property)
  .delete("/products/:id", async ({ params: { id }, headers }) => {
    const user = await verifyAuth(headers);

    // CSRF Token validation
    const csrfToken = headers['x-csrf-token'] || headers['X-CSRF-Token'];
    if (!csrfToken || !validateCSRFToken(csrfToken as string, user.id)) {
      throw new Error("Security Alert: Invalid or missing CSRF token");
    }

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
    await verifyAdmin(headers);

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

  // Real-time notifications setup
  .get("/realtime/subscribe", async ({ set }) => {
    // This endpoint will be used by the frontend to establish a WebSocket connection
    // In a real implementation, you'd set up the WebSocket connection here
    // For now, we'll return a simple confirmation that real-time is available
    set.status = 200;
    return {
      message: "Real-time notifications service is available",
      features: ["new_property_listings", "property_status_updates", "user_messages"]
    };
  })

  // 11. Admin-only delete endpoint (protected)
  .delete("/admin/products/:id", async ({ params: { id }, headers }) => {
    await verifyAdmin(headers);

    // Delete property
    const { error } = await supabase
      .from("properties")
      .delete()
      .eq("id", id);

    if (error) throw error;
    return { success: true, message: "Property deleted by admin" };
  })

  // CSRF Token Endpoint
  .get("/csrf-token", async ({ headers }) => {
    const user = await verifyAuth(headers);
    const token = generateCSRFToken(user.id);
    return { csrfToken: token };
  })

  // Health check endpoint for Render/monitoring
  .get("/health", () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  }))

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

  .listen({
    port: Number(process.env.PORT) || 4000,
    hostname: '0.0.0.0'
  });

console.log(`🦊 Server running on port ${Number(process.env.PORT) || 4000}`);

console.log(
  `🦊 Property API is running at ${app.server?.hostname}:${app.server?.port}`
);
