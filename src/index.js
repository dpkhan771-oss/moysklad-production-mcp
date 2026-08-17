import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  listProcessingPlans,
  getProcessingPlanDetail,
  listProductionTasks,
  getProductionTaskDetail,
  getProfitByProduct,
  getMarginBySegment,
  getStockAll,
  listProducts,
  getCompanySettings,
  getReconciliationReport,
  listStores,
  listCounterparties,
} from "./moysklad.js";

function buildServer() {
  const server = new McpServer({
    name: "moysklad-production",
    version: "1.0.0",
  });

  server.tool(
    "list_processing_plans",
    "Список технологических карт (техкарт) производства. Можно искать по названию. По умолчанию возвращает до 1000 карт; используй all=true, чтобы получить полный список за несколько запросов, либо offset для ручной постраничной навигации.",
    {
      search: z.string().optional().describe("Поиск по названию техкарты"),
      limit: z.number().int().min(1).max(1000).optional().describe("Максимум записей за один запрос (по умолчанию 1000)"),
      offset: z.number().int().min(0).optional().describe("Смещение для постраничной навигации"),
      all: z.boolean().optional().describe("Забрать все страницы целиком, игнорируя limit/offset"),
    },
    async ({ search, limit, offset, all }) => {
      const plans = await listProcessingPlans({ search, limit, offset, all });
      return { content: [{ type: "text", text: JSON.stringify(plans, null, 2) }] };
    }
  );

  server.tool(
    "get_processing_plan_detail",
    "Подробности техкарты: состав материалов (сырья) с нормами расхода и выпускаемая продукция. Используй для анализа и оптимизации производственных карт.",
    { id: z.string().describe("UUID техкарты, полученный из list_processing_plans") },
    async ({ id }) => {
      const detail = await getProcessingPlanDetail(id);
      return { content: [{ type: "text", text: JSON.stringify(detail, null, 2) }] };
    }
  );

  server.tool(
    "list_production_tasks",
    "Список производственных заданий (заказов на производство) с их статусом и количеством.",
    {
      momentFrom: z.string().optional().describe("Дата начала периода, формат YYYY-MM-DD HH:MM:SS"),
      momentTo: z.string().optional().describe("Дата конца периода, формат YYYY-MM-DD HH:MM:SS"),
    },
    async ({ momentFrom, momentTo }) => {
      const tasks = await listProductionTasks({ momentFrom, momentTo });
      return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
    }
  );

  server.tool(
    "get_production_task_detail",
    "Диагностика: подробности конкретного производственного задания, включая распознанные позиции выпускаемой продукции и сырых ключей объекта (для проверки реальных названий полей МойСклад).",
    { id: z.string().describe("UUID производственного задания, полученный из list_production_tasks") },
    async ({ id }) => {
      const detail = await getProductionTaskDetail(id);
      return { content: [{ type: "text", text: JSON.stringify(detail, null, 2) }] };
    }
  );

  server.tool(
    "get_profit_by_product",
    "Отчёт по марже и себестоимости для каждого товара за период (выручка, себестоимость, прибыль, % маржи).",
    {
      momentFrom: z.string().optional().describe("Начало периода, YYYY-MM-DD HH:MM:SS"),
      momentTo: z.string().optional().describe("Конец периода, YYYY-MM-DD HH:MM:SS"),
    },
    async ({ momentFrom, momentTo }) => {
      const rows = await getProfitByProduct({ momentFrom, momentTo });
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.tool(
    "get_margin_by_segment",
    "Маржинальность, сгруппированная по сегментам (категориям/группам товаров) за период.",
    {
      momentFrom: z.string().optional().describe("Начало периода, YYYY-MM-DD HH:MM:SS"),
      momentTo: z.string().optional().describe("Конец периода, YYYY-MM-DD HH:MM:SS"),
    },
    async ({ momentFrom, momentTo }) => {
      const rows = await getMarginBySegment({ momentFrom, momentTo });
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.tool(
    "list_stores",
    "Список складов организации (например, Астана, Алматы) с их ID. Используй storeId отсюда в get_stock_all, чтобы получить остатки по конкретному складу вместо суммы по всем сразу.",
    {},
    async () => {
      const stores = await listStores();
      return { content: [{ type: "text", text: JSON.stringify(stores, null, 2) }] };
    }
  );

  server.tool(
    "get_stock_all",
    "Остатки товаров на складах (сырьё и готовая продукция): количество, резерв, цена. Поиск по названию фильтруется на стороне сервера (МойСклад не поддерживает search для этого отчёта). Без storeId суммирует остатки по ВСЕМ складам сразу — передай storeId (см. list_stores), чтобы получить остатки только по одному складу (например, отдельно Астана и отдельно Алматы). Возвращает только позиции с ненулевым остатком — для товаров с нулевым остатком (полностью израсходованное сырьё/комплектующие) используй list_products и поле lastPurchasePrice.",
    {
      search: z.string().optional().describe("Поиск по названию товара (подстрока, без учёта регистра)"),
      storeId: z.string().optional().describe("UUID склада из list_stores — ограничить остатки одним складом"),
    },
    async ({ search, storeId }) => {
      const stock = await getStockAll({ search, storeId });
      return { content: [{ type: "text", text: JSON.stringify(stock, null, 2) }] };
    }
  );

  server.tool(
    "list_products",
    "Список товаров (справочник) с их ID, названием, кодом, артикулом и ценой последней закупки (lastPurchasePrice — учётная себестоимость на карточке товара, доступна даже при нулевом остатке, в отличие от get_stock_all). По умолчанию до 1000 записей за запрос; используй all=true, чтобы получить полный список за несколько запросов, либо offset для постраничной навигации.",
    {
      search: z.string().optional().describe("Поиск по названию товара"),
      limit: z.number().int().min(1).max(1000).optional().describe("Максимум записей за один запрос (по умолчанию 1000)"),
      offset: z.number().int().min(0).optional().describe("Смещение для постраничной навигации"),
      all: z.boolean().optional().describe("Забрать все страницы целиком, игнорируя limit/offset"),
    },
    async ({ search, limit, offset, all }) => {
      const products = await listProducts({ search, limit, offset, all });
      return { content: [{ type: "text", text: JSON.stringify(products, null, 2) }] };
    }
  );

  server.tool(
    "get_company_settings",
    "Настройки организации МойСклад: валюта, учёт себестоимости и прочие общие параметры.",
    {},
    async () => {
      const settings = await getCompanySettings();
      return { content: [{ type: "text", text: JSON.stringify(settings, null, 2) }] };
    }
  );

  server.tool(
    "list_counterparties",
    "Список контрагентов (покупатели, поставщики) с городом и адресом. Используй city для фильтра по городу (например 'Алматы') — ищет без учёта регистра по структурированному полю город и по текстовым адресам; такой поиск всегда забирает контрагентов постранично целиком, так как МойСклад не поддерживает серверный фильтр по городу. Без city — обычный список (до 1000 записей за запрос, offset для навигации, all=true — забрать всё).",
    {
      search: z.string().optional().describe("Поиск по названию контрагента (серверный поиск МойСклад)"),
      city: z.string().optional().describe("Фильтр по городу, например 'Алматы' (без учёта регистра, ищет и по структурированному полю, и по тексту адреса)"),
      limit: z.number().int().min(1).max(1000).optional().describe("Максимум записей за один запрос (по умолчанию 1000, игнорируется при указанном city)"),
      offset: z.number().int().min(0).optional().describe("Смещение для постраничной навигации (игнорируется при указанном city)"),
      all: z.boolean().optional().describe("Забрать все страницы целиком, игнорируя limit/offset"),
    },
    async ({ search, city, limit, offset, all }) => {
      const counterparties = await listCounterparties({ search, city, limit, offset, all });
      return { content: [{ type: "text", text: JSON.stringify(counterparties, null, 2) }] };
    }
  );

  server.tool(
    "get_reconciliation_report",
    "Акт сверки взаиморасчётов с контрагентом за период: находит контрагента по названию, собирает отгрузки, приёмки, оплаты и возвраты, и строит таблицу с бегущим сальдо (начальный остаток, дебет/кредит по каждому документу, конечный остаток).",
    {
      counterpartyName: z.string().describe("Название контрагента для поиска, например 'ИП Хаузер'"),
      momentFrom: z.string().optional().describe("Начало периода, YYYY-MM-DD HH:MM:SS. Если не указано — начальный остаток считается нулевым"),
      momentTo: z.string().optional().describe("Конец периода, YYYY-MM-DD HH:MM:SS"),
    },
    async ({ counterpartyName, momentFrom, momentTo }) => {
      const report = await getReconciliationReport({ counterpartyName, momentFrom, momentTo });
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

const port = process.env.PORT || process.env.HTTP_PORT || 3000;
app.listen(port, () => {
  console.log(`moysklad-production-mcp слушает порт ${port}`);
});
