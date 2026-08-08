import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  listProcessingPlans,
  getProcessingPlanDetail,
  listProductionTasks,
  getProfitByProduct,
  getMarginBySegment,
  getStockAll,
  listProducts,
  getCompanySettings,
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
    "get_stock_all",
    "Остатки товаров на складах (сырьё и готовая продукция): количество, резерв, цена. Можно искать по названию.",
    { search: z.string().optional().describe("Поиск по названию товара") },
    async ({ search }) => {
      const stock = await getStockAll({ search });
      return { content: [{ type: "text", text: JSON.stringify(stock, null, 2) }] };
    }
  );

  server.tool(
    "list_products",
    "Список товаров (справочник) с их ID, названием, кодом и артикулом. Можно искать по названию.",
    { search: z.string().optional().describe("Поиск по названию товара") },
    async ({ search }) => {
      const products = await listProducts({ search });
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
