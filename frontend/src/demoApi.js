// In-browser stand-in for the Express + MongoDB backend, used for the static
// GitHub Pages demo (REACT_APP_DEMO=true). It mirrors the routes in
// backend/routes/* and keeps its data in localStorage, so every visitor gets
// their own sandboxed store. The real backend is unchanged.
import axios from 'axios';
import seedProducts from './demoSeed.json';

const DB_KEY = 'amazona-demo-db-v2';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const PAGE_SIZE = 3;

const now = () => new Date().toISOString();
const newId = () =>
  Date.now().toString(16) + Math.random().toString(16).slice(2, 10);

function seed() {
  const createdAt = now();
  return {
    users: [
      { _id: 'u1', name: 'Admin', email: 'admin@example.com', password: '123456', isAdmin: true, createdAt },
      { _id: 'u2', name: 'John', email: 'user@example.com', password: '123456', isAdmin: false, createdAt },
    ],
    products: seedProducts.map((p) => ({
      ...p,
      image: PUBLIC_URL + p.image,
      createdAt,
      updatedAt: createdAt,
    })),
    orders: sampleOrders(),
  };
}

// A couple of weeks of paid sample orders so the admin dashboard has data.
function sampleOrders() {
  const products = seedProducts.map((p) => ({ ...p, image: PUBLIC_URL + p.image }));
  const orders = [];
  let n = 0;
  for (let daysAgo = 13; daysAgo >= 1; daysAgo--) {
    const count = 1 + ((daysAgo * 7) % 3);
    for (let k = 0; k < count; k++) {
      const p = products[(daysAgo + k) % products.length];
      const qty = 1 + ((daysAgo + k) % 2);
      const itemsPrice = p.price * qty;
      const shippingPrice = itemsPrice > 100 ? 0 : 10;
      const taxPrice = Math.round(itemsPrice * 0.15 * 100) / 100;
      const date = new Date(Date.now() - daysAgo * 86400000 + k * 3600000).toISOString();
      orders.push({
        _id: 'sample' + ++n,
        orderItems: [{ ...p, quantity: qty, product: p._id }],
        shippingAddress: { fullName: 'Sample Customer', address: '1 Demo Street', city: 'Chennai', postalCode: '600001', country: 'India' },
        paymentMethod: 'PayPal',
        itemsPrice, shippingPrice, taxPrice,
        totalPrice: itemsPrice + shippingPrice + taxPrice,
        user: 'u2',
        isPaid: true, paidAt: date,
        isDelivered: daysAgo > 3, deliveredAt: daysAgo > 3 ? date : undefined,
        createdAt: date,
      });
    }
  }
  return orders;
}

function load() {
  try {
    const db = JSON.parse(localStorage.getItem(DB_KEY));
    if (db && db.users && db.products && db.orders) return db;
  } catch (e) {}
  const db = seed();
  save(db);
  return db;
}

function save(db) {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch (e) {}
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const publicUser = (u) => ({
  _id: u._id,
  name: u.name,
  email: u.email,
  isAdmin: u.isAdmin,
  token: btoa(JSON.stringify({ _id: u._id })),
});

function authUser(db, config) {
  const h = config.headers || {};
  const raw = (h.get ? h.get('authorization') : h.authorization || h.Authorization) || '';
  try {
    const { _id } = JSON.parse(atob(raw.replace(/^Bearer /, '')));
    const user = db.users.find((u) => u._id === _id);
    if (user) return user;
  } catch (e) {}
  throw new HttpError(401, 'Invalid Token');
}

function adminUser(db, config) {
  const user = authUser(db, config);
  if (!user.isAdmin) throw new HttpError(401, 'Invalid Admin Token');
  return user;
}

function paginate(list, query) {
  const page = Number(query.get('page')) || 1;
  const pageSize = Number(query.get('pageSize')) || PAGE_SIZE;
  return {
    products: list.slice(pageSize * (page - 1), pageSize * page),
    countProducts: list.length,
    page,
    pages: Math.ceil(list.length / pageSize),
  };
}

function searchProducts(db, q) {
  const text = q.get('query') || '';
  const category = q.get('category') || '';
  const price = q.get('price') || '';
  const rating = q.get('rating') || '';
  const order = q.get('order') || '';
  let list = db.products.filter(
    (p) =>
      (!text || text === 'all' || p.name.toLowerCase().includes(text.toLowerCase())) &&
      (!category || category === 'all' || p.category === category) &&
      (!rating || rating === 'all' || p.rating >= Number(rating)) &&
      (!price ||
        price === 'all' ||
        (p.price >= Number(price.split('-')[0]) && p.price <= Number(price.split('-')[1])))
  );
  const sorters = {
    lowest: (a, b) => a.price - b.price,
    highest: (a, b) => b.price - a.price,
    toprated: (a, b) => b.rating - a.rating,
    newest: (a, b) => (b.createdAt > a.createdAt ? 1 : -1),
  };
  list = [...list].sort(sorters[order] || (() => 0));
  return paginate(list, q);
}

function summary(db) {
  const daily = {};
  db.orders.forEach((o) => {
    const day = o.createdAt.slice(0, 10);
    daily[day] = daily[day] || { _id: day, orders: 0, sales: 0 };
    daily[day].orders += 1;
    daily[day].sales += o.totalPrice;
  });
  const cats = {};
  db.products.forEach((p) => (cats[p.category] = (cats[p.category] || 0) + 1));
  return {
    users: [{ _id: null, numUsers: db.users.length }],
    orders: db.orders.length
      ? [{ _id: null, numOrders: db.orders.length, totalSales: db.orders.reduce((a, o) => a + o.totalPrice, 0) }]
      : [],
    dailyOrders: Object.values(daily).sort((a, b) => (a._id > b._id ? 1 : -1)),
    productCategories: Object.entries(cats).map(([_id, count]) => ({ _id, count })),
  };
}

function route(db, method, path, query, body, config) {
  const find = (list, id, what) => {
    const item = list.find((x) => x._id === id);
    if (!item) throw new HttpError(404, `${what} Not Found`);
    return item;
  };
  let m;

  // keys
  if (path === '/api/keys/paypal') return 'sb';
  if (path === '/api/keys/google') return { key: '' };
  if (path === '/api/upload') throw new HttpError(400, 'Image upload is disabled in the live demo');

  // products
  if (path === '/api/products') {
    if (method === 'get') return db.products;
    if (method === 'post') {
      adminUser(db, config);
      const t = Date.now();
      const product = {
        _id: newId(), name: 'sample name ' + t, slug: 'sample-name-' + t,
        image: PUBLIC_URL + '/images/p1.jpg', images: [], price: 0,
        category: 'sample category', brand: 'sample brand', countInStock: 0,
        rating: 0, numReviews: 0, reviews: [], description: 'sample description',
        createdAt: now(), updatedAt: now(),
      };
      db.products.push(product);
      return { message: 'Product Created', product };
    }
  }
  if (path === '/api/products/categories') return [...new Set(db.products.map((p) => p.category))];
  if (path === '/api/products/search') return searchProducts(db, query);
  if (path === '/api/products/admin') {
    adminUser(db, config);
    return paginate(db.products, query);
  }
  if ((m = path.match(/^\/api\/products\/slug\/(.+)$/))) {
    const product = db.products.find((p) => p.slug === decodeURIComponent(m[1]));
    if (!product) throw new HttpError(404, 'Product Not Found');
    return product;
  }
  if ((m = path.match(/^\/api\/products\/([^/]+)\/reviews$/)) && method === 'post') {
    const user = authUser(db, config);
    const product = find(db.products, m[1], 'Product');
    if (product.reviews.find((r) => r.name === user.name)) throw new HttpError(400, 'You already submitted a review');
    const review = { _id: newId(), name: user.name, rating: Number(body.rating), comment: body.comment, createdAt: now() };
    product.reviews.push(review);
    product.numReviews = product.reviews.length;
    product.rating = product.reviews.reduce((a, r) => a + r.rating, 0) / product.reviews.length;
    return { message: 'Review Created', review, numReviews: product.numReviews, rating: product.rating };
  }
  if ((m = path.match(/^\/api\/products\/([^/]+)$/))) {
    const product = find(db.products, m[1], 'Product');
    if (method === 'get') return product;
    adminUser(db, config);
    if (method === 'put') {
      ['name', 'slug', 'price', 'image', 'images', 'category', 'brand', 'countInStock', 'description'].forEach(
        (k) => (product[k] = body[k])
      );
      product.updatedAt = now();
      return { message: 'Product Updated' };
    }
    if (method === 'delete') {
      db.products = db.products.filter((p) => p !== product);
      return { message: 'Product Deleted' };
    }
  }

  // users
  if (path === '/api/users/signin') {
    const user = db.users.find((u) => u.email === body.email && u.password === body.password);
    if (!user) throw new HttpError(401, 'Invalid email or password');
    return publicUser(user);
  }
  if (path === '/api/users/signup') {
    if (db.users.find((u) => u.email === body.email)) throw new HttpError(400, 'Email already registered');
    const user = { _id: newId(), name: body.name, email: body.email, password: body.password, isAdmin: false, createdAt: now() };
    db.users.push(user);
    return publicUser(user);
  }
  if (path === '/api/users/forget-password') {
    if (!db.users.find((u) => u.email === body.email)) throw new HttpError(404, 'User not found');
    return { message: 'Demo mode: emails are not sent. Sign in with your existing password.' };
  }
  if (path === '/api/users/reset-password') throw new HttpError(400, 'Password reset emails are disabled in the live demo');
  if (path === '/api/users/profile' && method === 'put') {
    const user = authUser(db, config);
    user.name = body.name || user.name;
    user.email = body.email || user.email;
    if (body.password) user.password = body.password;
    return publicUser(user);
  }
  if (path === '/api/users') {
    adminUser(db, config);
    return db.users.map(({ password, ...u }) => u);
  }
  if ((m = path.match(/^\/api\/users\/([^/]+)$/))) {
    adminUser(db, config);
    const user = find(db.users, m[1], 'User');
    if (method === 'get') {
      const { password, ...rest } = user;
      return rest;
    }
    if (method === 'put') {
      user.name = body.name || user.name;
      user.email = body.email || user.email;
      user.isAdmin = Boolean(body.isAdmin);
      return { message: 'User Updated', user };
    }
    if (method === 'delete') {
      if (user.email === 'admin@example.com') throw new HttpError(400, 'Can Not Delete Admin User');
      db.users = db.users.filter((u) => u !== user);
      return { message: 'User Deleted' };
    }
  }

  // orders
  if (path === '/api/orders') {
    if (method === 'get') {
      adminUser(db, config);
      return db.orders.map((o) => {
        const u = db.users.find((x) => x._id === o.user);
        return { ...o, user: u ? { _id: u._id, name: u.name } : null };
      });
    }
    if (method === 'post') {
      const user = authUser(db, config);
      const order = {
        _id: newId(),
        orderItems: body.orderItems.map((x) => ({ ...x, product: x._id })),
        shippingAddress: body.shippingAddress,
        paymentMethod: body.paymentMethod,
        itemsPrice: body.itemsPrice,
        shippingPrice: body.shippingPrice,
        taxPrice: body.taxPrice,
        totalPrice: body.totalPrice,
        user: user._id,
        isPaid: false,
        isDelivered: false,
        createdAt: now(),
      };
      db.orders.push(order);
      return { message: 'New Order Created', order };
    }
  }
  if (path === '/api/orders/summary') {
    adminUser(db, config);
    return summary(db);
  }
  if (path === '/api/orders/mine') {
    const user = authUser(db, config);
    return db.orders.filter((o) => o.user === user._id);
  }
  if ((m = path.match(/^\/api\/orders\/([^/]+)(\/pay|\/deliver)?$/))) {
    const user = authUser(db, config);
    const order = find(db.orders, m[1], 'Order');
    if (!user.isAdmin && order.user !== user._id) throw new HttpError(403, 'Not allowed to access this order');
    if (!m[2] && method === 'get') return order;
    if (!m[2] && method === 'delete') {
      adminUser(db, config);
      db.orders = db.orders.filter((o) => o !== order);
      return { message: 'Order Deleted' };
    }
    if (m[2] === '/pay') {
      order.isPaid = true;
      order.paidAt = now();
      order.paymentResult = { id: body.id, status: body.status, update_time: body.update_time, email_address: body.email_address };
      return { message: 'Order Paid', order };
    }
    if (m[2] === '/deliver') {
      adminUser(db, config);
      order.isDelivered = true;
      order.deliveredAt = now();
      return { message: 'Order Delivered' };
    }
  }

  throw new HttpError(404, `No demo route for ${method.toUpperCase()} ${path}`);
}

export function installDemoApi() {
  axios.defaults.adapter = async (config) => {
    const url = new URL(String(config.url).trim(), window.location.origin);
    const method = (config.method || 'get').toLowerCase();
    let body = config.data;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {}
    }
    await new Promise((r) => setTimeout(r, 150)); // feel like a network call
    const db = load();
    try {
      const data = route(db, method, url.pathname.replace(/\/$/, ''), url.searchParams, body || {}, config);
      save(db);
      return { data: JSON.parse(JSON.stringify(data)), status: 200, statusText: 'OK', headers: {}, config, request: {} };
    } catch (err) {
      const status = err.status || 500;
      const error = new Error(err.message);
      error.config = config;
      error.response = { data: { message: err.message }, status, statusText: 'Error', headers: {}, config };
      throw error;
    }
  };
}

export const isDemo = process.env.REACT_APP_DEMO === 'true';
