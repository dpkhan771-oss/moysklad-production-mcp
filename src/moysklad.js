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

export async function listProcessingPlans({ search, limit = 1000, offset = 0, all = false } = {}) {
  const baseQuery = {};
  if (search) baseQuery.search = search;

  if (!all) {
    const data = await msRequest("/entity/processingplan", {
      query: { ...baseQuery, limit, offset },
    });
    return (data.rows || []).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description || null,
    }));
  }

  // Забираем все страницы, чтобы не ограничиваться лимитом одного запроса.
  const pageSize = 1000;
  const rows = [];
  let currentOffset = offset;
  while (true) {
    const data = await msRequest("/entity/processingplan", {
      query: { ...baseQuery, limit: pageSize, offset: currentOffset },
    });
    const pageRows = data.rows || [];
    rows.push(...pageRows);
    const total = data.meta?.size ?? rows.length;
    currentOffset += pageSize;
    if (pageRows.length < pageSize || currentOffset >= total) break;
  }
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description || null,
  }));
}

export async function getProcessingPlanDetail(id) {
  // expand требует явного limit<=100, иначе МойСклад молча игнорирует expand.
  const plan = await msRequest(`/entity/processingplan/${id}`, {
    query: { expand: "materials.assortment,products.assortment", limit: 100 },
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

function mapAssortmentRows(rows) {
  return (rows || []).map((r) => ({
    name: r.assortment?.name || r.name || "неизвестно",
    quantity: r.quantity,
    unit: r.assortment?.unit?.name || null,
    rawKeys: Object.keys(r), // ДИАГНОСТИКА: quantity пуст у productiontaskresult — ищем реальное имя поля
  }));
}

// products на productiontask — не встраиваемая коллекция (expand на ней
// возвращает ошибку 1089 "Expand поля 'products' не поддерживается"), а
// отдельный вложенный под-ресурс: {meta: {href: ".../productiontask/{id}/products", size, ...}}.
// Его нужно запрашивать отдельным GET по этому href, с собственным expand=assortment.
async function fetchTaskProducts(taskId) {
  const data = await msRequest(`/entity/productiontask/${taskId}/products`, {
    query: { expand: "assortment", limit: 100 },
  });
  return mapAssortmentRows(data.rows || data);
}

export async function listProductionTasks({ limit = 50, momentFrom, momentTo } = {}) {
  const query = {
    limit: Math.min(limit, 100),
    order: "moment,desc",
    expand: "state",
  };
  const filters = [];
  if (momentFrom) filters.push(`moment>=${momentFrom}`);
  if (momentTo) filters.push(`moment<=${momentTo}`);
  if (filters.length) query.filter = filters.join(";");

  const data = await msRequest("/entity/productiontask", { query });
  const tasks = (data.rows || []).map((t) => ({
    id: t.id,
    name: t.name,
    moment: t.moment,
    state: t.state?.name || null,
    applicable: t.applicable,
  }));

  const concurrency = 8;
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const productsBatch = await Promise.all(batch.map((t) => fetchTaskProducts(t.id)));
    batch.forEach((t, idx) => {
      t.products = productsBatch[idx];
    });
  }

  return tasks;
}

export async function getProductionTaskDetail(id) {
  const task = await msRequest(`/entity/productiontask/${id}`, {
    query: { expand: "state", limit: 100 },
  });

  return {
    id: task.id,
    name: task.name,
    moment: task.moment,
    state: task.state?.name || null,
    applicable: task.applicable,
    products: await fetchTaskProducts(id),
  };
}

export async function getProfitByProduct({ momentFrom, momentTo } = {}) {
  const baseQuery = { expand: "assortment.productFolder" };
  if (momentFrom && momentTo) {
    baseQuery.momentFrom = momentFrom;
    baseQuery.momentTo = momentTo;
  }

  // expand требует явного limit<=100, иначе МойСклад молча игнорирует expand,
  // поэтому пагинируем, чтобы не терять товары при большом ассортименте.
  const pageSize = 100;
  const rows = [];
  let offset = 0;
  while (true) {
    const data = await msRequest("/report/profit/byproduct", {
      query: { ...baseQuery, limit: pageSize, offset },
    });
    const pageRows = data.rows || [];
    rows.push(...pageRows);
    const total = data.meta?.size ?? rows.length;
    offset += pageSize;
    if (pageRows.length < pageSize || offset >= total) break;
  }

  // В отчёте МойСклад sellSum — выручка, а sellCostSum — себестоимость проданного
  // (не выручка, несмотря на название). Поля costSum в ответе API не существует.
  // margin — уже готовая рентабельность товара, отдаваемая самим МойСклад.
  return rows.map((r) => ({
    name: r.assortment?.name,
    productFolder:
      r.assortment?.productFolder?.name || r.assortment?.pathName || null,
    sellQuantity: r.sellQuantity,
    revenue: kopecksToRubles(r.sellSum),
    cost: kopecksToRubles(r.sellCostSum),
    profit: kopecksToRubles(r.profit),
    marginPercent: r.margin ?? null,
  }));
}

export async function getMarginBySegment({ momentFrom, momentTo } = {}) {
  const rows = await getProfitByProduct({ momentFrom, momentTo });
  const bySegment = {};
  for (const r of rows) {
    const key = r.productFolder || "Без категории";
    if (!bySegment[key]) {
      bySegment[key] = { segment: key, revenue: 0, cost: 0, profit: 0, products: 0 };
    }
    bySegment[key].revenue += r.revenue || 0;
    bySegment[key].cost += r.cost || 0;
    bySegment[key].profit += r.profit || 0;
    bySegment[key].products += 1;
  }
  return Object.values(bySegment).map((s) => ({
    ...s,
    revenue: Math.round(s.revenue * 100) / 100,
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
    article: p.article || null,
  }));
}

export async function getCompanySettings() {
  const data = await msRequest("/context/companysettings");
  return data;
}
