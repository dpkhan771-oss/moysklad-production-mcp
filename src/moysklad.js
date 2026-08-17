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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function msRequest(path, { method = "GET", query, body } = {}, retriesLeft = 3) {
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
  if (res.status === 429 && retriesLeft > 0) {
    // МойСклад ограничивает число одновременных запросов (code 1073) — при
    // параллельных пачках запросов это ожидаемо, ретраим с задержкой.
    await sleep(700);
    return msRequest(path, { method, query, body }, retriesLeft - 1);
  }
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
    // productiontaskresult называет количество "planQuantity", а не "quantity"
    // (подтверждено через rawKeys на живом задании).
    quantity: r.quantity ?? r.planQuantity ?? null,
    unit: r.assortment?.unit?.name || null,
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

async function attachProducts(tasks) {
  const concurrency = 3;
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const productsBatch = await Promise.all(batch.map((t) => fetchTaskProducts(t.id)));
    batch.forEach((t, idx) => {
      t.products = productsBatch[idx];
    });
  }
  return tasks;
}

export async function listProductionTasks({ limit = 50, momentFrom, momentTo } = {}) {
  const filters = [];
  if (momentFrom) filters.push(`moment>=${momentFrom}`);
  if (momentTo) filters.push(`moment<=${momentTo}`);

  // Инструмент list_production_tasks в MCP-схеме принимает только momentFrom/
  // momentTo (без отдельного флага агрегации). Поэтому: если задан ПОЛНЫЙ
  // период (обе границы), считаем, что вызывающий хочет сводку по всему
  // периоду, и забираем ВСЕ страницы заданий (не ограничиваясь одной), сразу
  // суммируя выпуск по названию продукции. Без периода — обычный список
  // последних заданий (limit), как раньше.
  if (momentFrom && momentTo) {
    const pageSize = 100;
    const allTasks = [];
    let offset = 0;
    while (true) {
      const data = await msRequest("/entity/productiontask", {
        query: { limit: pageSize, offset, order: "moment,desc", expand: "state", filter: filters.join(";") },
      });
      const rows = data.rows || [];
      allTasks.push(
        ...rows.map((t) => ({ id: t.id, moment: t.moment, state: t.state?.name || null }))
      );
      const total = data.meta?.size ?? allTasks.length;
      offset += pageSize;
      if (rows.length < pageSize || offset >= total) break;
    }

    const completed = allTasks.filter((t) => (t.state || "").toLowerCase().includes("выполн"));
    await attachProducts(completed);

    const byProduct = {};
    for (const t of completed) {
      for (const p of t.products) {
        const key = p.name;
        if (!byProduct[key]) byProduct[key] = { product: key, unit: p.unit, quantity: 0, taskCount: 0 };
        byProduct[key].quantity += p.quantity || 0;
        byProduct[key].taskCount += 1;
      }
    }

    return {
      tasksTotal: allTasks.length,
      tasksCompleted: completed.length,
      products: Object.values(byProduct)
        .map((r) => ({ ...r, quantity: Math.round(r.quantity * 100) / 100 }))
        .sort((a, b) => b.quantity - a.quantity),
    };
  }

  const query = {
    limit: Math.min(limit, 100),
    order: "moment,desc",
    expand: "state",
  };
  if (filters.length) query.filter = filters.join(";");

  const data = await msRequest("/entity/productiontask", { query });
  const tasks = (data.rows || []).map((t) => ({
    id: t.id,
    name: t.name,
    moment: t.moment,
    state: t.state?.name || null,
    applicable: t.applicable,
  }));

  return attachProducts(tasks);
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

export async function listStores() {
  const data = await msRequest("/entity/store");
  return (data.rows || []).map((s) => ({
    id: s.id,
    name: s.name,
    archived: !!s.archived,
  }));
}

export async function getStockAll({ search, storeId } = {}) {
  // /report/stock/all игнорирует query-параметр search (МойСклад его не
  // поддерживает для этого отчёта — он молча возвращает первую страницу
  // независимо от значения), поэтому раньше search не работал и вдобавок
  // результат обрезался фиксированным limit=100. Забираем отчёт целиком
  // постранично и фильтруем по названию на своей стороне.
  //
  // Без storeId отчёт суммирует остатки по ВСЕМ складам сразу (например,
  // Астана + Алматы вместе) — передай storeId (см. list_stores), чтобы
  // получить остатки только по одному складу.
  const query = { limit: 1000 };
  if (storeId) {
    query.filter = `store=${BASE_URL}/entity/store/${storeId}`;
  }

  const pageSize = 1000;
  const rows = [];
  let offset = 0;
  while (true) {
    const data = await msRequest("/report/stock/all", {
      query: { ...query, offset },
    });
    const pageRows = data.rows || data;
    rows.push(...pageRows);
    const total = data.meta?.size ?? rows.length;
    offset += pageSize;
    if (pageRows.length < pageSize || offset >= total) break;
  }

  const needle = search ? search.toLowerCase() : null;
  const filtered = needle
    ? rows.filter((r) => (r.name || "").toLowerCase().includes(needle))
    : rows;

  return filtered.map((r) => ({
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

export async function listProducts({ search, limit = 1000, offset = 0, all = false } = {}) {
  const baseQuery = {};
  if (search) baseQuery.search = search;
  // buyPrice — цена последней закупки/учётная себестоимость на карточке
  // товара. Она хранится независимо от текущего остатка, поэтому это
  // единственный надёжный источник цены для позиций с нулевым остатком
  // (например, крышки и этикетки, которые полностью израсходованы в
  // производстве и потому не попадают в /report/stock/all).

  if (!all) {
    const data = await msRequest("/entity/product", {
      query: { ...baseQuery, limit, offset },
    });
    return (data.rows || []).map(mapProduct);
  }

  const pageSize = 1000;
  const rows = [];
  let currentOffset = offset;
  while (true) {
    const data = await msRequest("/entity/product", {
      query: { ...baseQuery, limit: pageSize, offset: currentOffset },
    });
    const pageRows = data.rows || [];
    rows.push(...pageRows);
    const total = data.meta?.size ?? rows.length;
    currentOffset += pageSize;
    if (pageRows.length < pageSize || currentOffset >= total) break;
  }
  return rows.map(mapProduct);
}

function mapProduct(p) {
  return {
    id: p.id,
    name: p.name,
    code: p.code || null,
    article: p.article || null,
    lastPurchasePrice: kopecksToRubles(p.buyPrice?.value),
  };
}

export async function getCompanySettings() {
  const data = await msRequest("/context/companysettings");
  return data;
}

function mapCounterparty(c) {
  return {
    id: c.id,
    name: c.name,
    companyType: c.companyType || null,
    city: c.actualAddressFull?.city || c.legalAddressFull?.city || null,
    actualAddress: c.actualAddress || null,
    legalAddress: c.legalAddress || null,
    phone: c.phone || null,
    email: c.email || null,
    archived: !!c.archived,
  };
}

export async function listCounterparties({ search, city, limit = 1000, offset = 0, all = false } = {}) {
  const baseQuery = {};
  if (search) baseQuery.search = search;

  // МойСклад не поддерживает filter по вложенным полям адреса
  // (actualAddressFull.city), поэтому при указанном city забираем весь
  // список постранично и фильтруем на своей стороне — как get_stock_all
  // делает для search.
  if (!all && !city) {
    const data = await msRequest("/entity/counterparty", {
      query: { ...baseQuery, limit, offset },
    });
    return (data.rows || []).map(mapCounterparty);
  }

  const pageSize = 1000;
  const rows = [];
  let currentOffset = all ? offset : 0;
  while (true) {
    const data = await msRequest("/entity/counterparty", {
      query: { ...baseQuery, limit: pageSize, offset: currentOffset },
    });
    const pageRows = data.rows || [];
    rows.push(...pageRows);
    const total = data.meta?.size ?? rows.length;
    currentOffset += pageSize;
    if (pageRows.length < pageSize || currentOffset >= total) break;
  }

  const mapped = rows.map(mapCounterparty);
  if (!city) return mapped;

  const needle = city.toLowerCase();
  return mapped.filter((c) =>
    [c.city, c.actualAddress, c.legalAddress].some((v) => (v || "").toLowerCase().includes(needle))
  );
}

export async function findCounterparty(name) {
  const data = await msRequest("/entity/counterparty", {
    query: { search: name, limit: 10 },
  });
  const rows = data.rows || [];
  if (rows.length === 0) {
    throw new Error(`Контрагент "${name}" не найден в МоемСкладе`);
  }
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    meta: c.meta,
  }));
}

// Типы документов, формирующих взаиморасчёты с контрагентом, и их влияние на
// сальдо "контрагент должен нам" (netEffect=+1 увеличивает эту задолженность,
// -1 уменьшает — покрывает как продажи, так и закупки у контрагента).
const RECONCILIATION_DOC_TYPES = [
  { path: "/entity/demand", label: "Отгрузка", netEffect: 1 },
  { path: "/entity/paymentin", label: "Оплата от контрагента", netEffect: -1 },
  { path: "/entity/salesreturn", label: "Возврат от покупателя", netEffect: -1 },
  { path: "/entity/supply", label: "Приёмка от контрагента", netEffect: -1 },
  { path: "/entity/paymentout", label: "Оплата контрагенту", netEffect: 1 },
  { path: "/entity/purchasereturn", label: "Возврат контрагенту", netEffect: 1 },
];

async function fetchDocsByAgent(path, agentHref, { momentFrom, momentTo } = {}) {
  const filters = [`agent=${agentHref}`];
  if (momentFrom) filters.push(`moment>=${momentFrom}`);
  if (momentTo) filters.push(`moment<=${momentTo}`);

  const pageSize = 100;
  const rows = [];
  let offset = 0;
  while (true) {
    const data = await msRequest(path, {
      query: { filter: filters.join(";"), limit: pageSize, offset, order: "moment,asc" },
    });
    const pageRows = data.rows || [];
    rows.push(...pageRows);
    const total = data.meta?.size ?? rows.length;
    offset += pageSize;
    if (pageRows.length < pageSize || offset >= total) break;
  }
  // Сальдо считаем только по проведённым документам.
  return rows.filter((r) => r.applicable !== false);
}

export async function getReconciliationReport({ counterpartyName, momentFrom, momentTo }) {
  const matches = await findCounterparty(counterpartyName);
  const counterparty = matches[0];
  const agentHref = counterparty.meta.href;

  let openingBalance = 0;
  if (momentFrom) {
    const priorDocs = await Promise.all(
      RECONCILIATION_DOC_TYPES.map((cfg) =>
        fetchDocsByAgent(cfg.path, agentHref, { momentTo: momentFrom }).then((docs) =>
          docs
            .filter((d) => d.moment < momentFrom)
            .reduce((sum, d) => sum + kopecksToRubles(d.sum) * cfg.netEffect, 0)
        )
      )
    );
    openingBalance = Math.round(priorDocs.reduce((a, b) => a + b, 0) * 100) / 100;
  }

  const docsByType = await Promise.all(
    RECONCILIATION_DOC_TYPES.map((cfg) => fetchDocsByAgent(cfg.path, agentHref, { momentFrom, momentTo }))
  );

  const movements = [];
  RECONCILIATION_DOC_TYPES.forEach((cfg, idx) => {
    for (const doc of docsByType[idx]) {
      const amount = kopecksToRubles(doc.sum) || 0;
      movements.push({
        moment: doc.moment,
        docType: cfg.label,
        docName: doc.name || null,
        amount,
        netEffect: cfg.netEffect,
      });
    }
  });
  movements.sort((a, b) => (a.moment < b.moment ? -1 : a.moment > b.moment ? 1 : 0));

  let balance = openingBalance;
  const rows = movements.map((m) => {
    // Положительный netEffect — контрагент должен нам больше (дебет),
    // отрицательный — контрагент должен нам меньше (кредит).
    const debit = m.netEffect > 0 ? m.amount : 0;
    const credit = m.netEffect < 0 ? m.amount : 0;
    balance = Math.round((balance + m.amount * m.netEffect) * 100) / 100;
    return {
      date: m.moment,
      docType: m.docType,
      docName: m.docName,
      debit,
      credit,
      balance,
    };
  });

  return {
    counterparty: { id: counterparty.id, name: counterparty.name },
    period: { from: momentFrom || null, to: momentTo || null },
    openingBalance,
    closingBalance: balance,
    // Положительное сальдо: контрагент должен нам. Отрицательное: мы должны контрагенту.
    balanceMeaning:
      balance > 0
        ? "Контрагент должен нам"
        : balance < 0
        ? "Мы должны контрагенту"
        : "Задолженность отсутствует",
    rows,
  };
}
