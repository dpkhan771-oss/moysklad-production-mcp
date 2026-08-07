import fetch from "node-fetch";

const BASE_URL = "https://api.moysklad.ru/api/remap/1.2";

function authHeader() {
  const token = process.env.MOYSKLAD_TOKEN;
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  const login = process.env.MOYSKLAD_LOGIN;
  const password = process.env.MOYSKLAD_PASSWORD;
  if (login && password) {
    const basic = Buffer.from(`${login}:${password}`).toString("base64");
    return { Authorization: `Basic ${basic}` };
  }
  throw new Error(
    "Не заданы переменные окружения MOYSKLAD_TOKEN или MOYSKLAD_LOGIN/MOYSKLAD_PASSWORD"
  );
}

async function msRequest(path, { method = "GET", query, body } = {}) {
  let url = `${BASE_URL}${path}`;
  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams(query);
    url += `?${params.toString()}`;
  }
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Accept-Encoding": "gzip",
      ...authHeader(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`МойСклад API ошибка ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

export function kopecksToRubles(v) {
  if (v === undefined || v === null) return null;
  return Math.round((v / 100) * 100) / 100;
}

export async function listProcessingPlans({ search, limit = 50 } = {}) {
  const query = { limit };
  if (search) query.search = search;
  const data = await msRequest("/entity/processingplan", { query });
  return (data.rows || []).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description || null,
  }));
}

export async function getProcessingPlanDetail(id) {
  const plan = await msRequest(`/entity/processingplan/${id}`, {
    query: { expand: "materials,products" },
  });

  const materials = (plan.materials?.rows || plan.materials || []).map((m) => ({
    name: m.assortment?.name || m.name || "неизвестно",
    quantity: m.quantity,
    unit: m.assortment?.unit?.name || null,
    consumption: m.consumption ?? null,
  }));

  const products = (plan.products?.rows || plan.products || []).map((p) => ({
    name: p.assortment?.name || p.name || "неизвестно",
    quantity: p.quantity,
  }));

  return {
    id: plan.id,
    name: plan.name,
    description: plan.description || null,
    materials,
    products,
  };
}

export async function listProductionTasks({ limit = 50, momentFrom, momentTo } = {}) {
  const query = { limit, order: "moment,desc" };
  const filters = [];
  if (momentFrom) filters.push(`moment>=${momentFrom}`);
  if (momentTo) filters.push(`moment<=${momentTo}`);
  if (filters.length) query.filter = filters.join(";");

  const data = await msRequest("/entity/productiontask", { query });
  return (data.rows || []).map((t) => ({
    id: t.id,
    name: t.name,
    moment: t.moment,
    state: t.state?.name || null,
    quantity: t.quantity,
    applicable: t.applicable,
  }));
}export async function getStockAll({ search, limit = 100 } = {}) {
  const query = { limit };
  if (search) query.search = search;
  const data = await msRequest("/report/stock/all", { query });
  return (data.rows || data).map((r) => ({
    name: r.name,
    code: r.code || null,
    article: r.article || null,
    quantity: r.quantity,
    reserve: r.reserve,
    inTransit: r.inTransit,
    stock: r.stock,
    price: kopecksToRubles(r.price),
    salePrice: kopecksToRubles(r.salePrice),
  }));
}

export async function listProducts({ search, limit = 100 } = {}) {
  const query = { limit };
  if (search) query.search = search;
  const data = await msRequest("/entity/product", { query });
  return (data.rows || []).map((p) => ({
    id: p.id,
    name: p.name,
    code: p.code || null,
    article: p.article || null,
  }));
}

export async function getCompanySettings() {
  const data = await msRequest("/context/companysettings");
  return data;
}
    cost: Math.round(s.cost * 100) / 100,
    profit: Math.round(s.profit * 100) / 100,
    marginPercent: s.cost ? Math.round((s.profit / s.cost) * 10000) / 100 : null,
  }));
}
export async function getStockAll({ search, limit = 100 } = {}) {
  const query = { limit };
  if (search) query.search = search;
  const data = await msRequest("/report/stock/all", { query });
  return (data.rows || data).map((r) => ({
    name: r.name,
    code: r.code || null,
    article: r.article || null,
    quantity: r.quantity,
    reserve: r.reserve,
    inTransit: r.inTransit,
    stock: r.stock,
    price: kopecksToRubles(r.price),
    salePrice: kopecksToRubles(r.salePrice),
  }));
}

export async function listProducts({ search, limit = 100 } = {}) {
  const query = { limit };
  if (search) query.search = search;
  const data = await msRequest("/entity/product", { query });
  return (data.rows || []).map((p) => ({
    id: p.id,
    name: p.name,
    code: p.code || null,
    async function getCompanySettings() {
  const response = await moyskladRequest('/context/companysettings');
  return {
    costTracking: response.priceTypes ? true : null, // уточним ниже
    currency: response.currency?.name || null,
    fifoEnabled: response.fifoEnabled ?? null,
    raw: response // временно, чтобы увидеть полный ответ и понять точное поле
  };
}

module.exports = {
  // ...existing exports
  getCompanySettings,
};
    article: p.article || null,
  }));
}

