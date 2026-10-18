import type { BuiltinFilter, BuiltinKitTemplate, TemplateTexts } from "./builtin-templates";
import { quote } from "./formula/lexer";

/**
 * The small business kit of the gallery: customers, the quotes given to them, jobs and a balance
 * sheet, linked to each other, with a dashboard over all four and a weekly plan. A quote links to
 * its customer, a job to its customer and to the quote it came from, and each customer shows its
 * quotes and jobs back; the balance sheet holds what the business owns and owes, one entry per
 * item on the day it is counted.
 *
 * It starts without example rows: it is meant for a business's own records, where made-up
 * customers would have to be found and deleted, and would count in the dashboard until then.
 */
export function smallBusiness(texts: TemplateTexts["small-business"], weeklyPlan: TemplateTexts["weekly-plan"]): BuiltinKitTemplate {
  const { dashboard, customers, quotes, jobs, balance } = texts;
  const c = customers.properties;
  const q = quotes.properties;
  const j = jobs.properties;
  const b = balance.properties;
  const w = dashboard.widgets;
  // One currency for the workspace; the property's menu changes it.
  const money = { format: "currency" as const, currency: texts.currency };

  const jobOpen: BuiltinFilter = { property: j.status, op: "is_none_of", value: [jobs.statuses.done] };
  const quoteOpen: BuiltinFilter = { property: q.status, op: "is_none_of", value: [quotes.statuses.accepted, quotes.statuses.lost] };
  const thisMonth: BuiltinFilter = { property: b.date, op: "is_within", value: "this_month" };
  // Follow-ups that are due, overdue (by up to ten years) or come within two weeks.
  const followUps = (property: string): BuiltinFilter => ({
    combinator: "or",
    rules: [
      { property, op: "is_within", value: "past_n_days", days: 3650 },
      { property, op: "is_within", value: "next_n_days", days: 14 },
    ],
  });
  const soonestFirst = (property: string) => [{ property, direction: "asc" as const }];

  return {
    key: "small-business",
    kind: "kit",
    icon: "🏪",
    title: texts.title,
    description: texts.description,
    parts: [
      {
        key: "dashboard",
        kind: "page",
        icon: "📊",
        title: dashboard.title,
        markdown: dashboard.markdown,
        // Four numbers on top, then two wide widgets a row: jobs, quotes, customers, the balance sheet.
        dashboard: [
          { database: "jobs", title: w.openJobs, span: 1, color: "blue", view: { type: "chart", config: { chartType: "number", filters: [jobOpen] } } },
          {
            database: "jobs",
            title: w.dueJobs,
            span: 1,
            color: "red",
            view: { type: "chart", config: { chartType: "number", filters: [jobOpen, { property: j.due, op: "is_within", value: "past_n_days", days: 3650 }] } },
          },
          { database: "quotes", title: w.openQuotes, span: 1, color: "orange", view: { type: "chart", config: { chartType: "number", filters: [quoteOpen] } } },
          {
            database: "balance",
            title: w.netWorth,
            span: 1,
            color: "green",
            view: { type: "chart", config: { chartType: "number", chartAggregate: { fn: "sum", property: b.net }, filters: [thisMonth] } },
          },
          {
            database: "jobs",
            title: w.jobsByPerson,
            span: 2,
            view: { type: "chart", config: { chartType: "bar", groupBy: j.assignee, stackBy: j.priority, showValues: true, filters: [jobOpen] } },
          },
          { database: "jobs", title: w.upcomingJobs, span: 2, view: { type: "list", config: { filters: [jobOpen], sorts: soonestFirst(j.due) } } },
          {
            database: "quotes",
            title: w.quotesByStatus,
            span: 2,
            view: { type: "chart", config: { chartType: "bar", groupBy: q.status, groupStatusBy: "option", showValues: true } },
          },
          {
            database: "quotes",
            title: w.quoteFollowUps,
            span: 2,
            view: { type: "list", config: { filters: [quoteOpen, followUps(q.followUp)], sorts: soonestFirst(q.followUp) } },
          },
          {
            database: "customers",
            title: w.customersByStage,
            span: 2,
            view: { type: "chart", config: { chartType: "horizontal_bar", groupBy: c.stage, showValues: true } },
          },
          {
            database: "customers",
            title: w.customerFollowUps,
            span: 2,
            view: { type: "list", config: { filters: [followUps(c.nextStepDate)], sorts: soonestFirst(c.nextStepDate) } },
          },
          {
            database: "balance",
            title: w.balanceBreakdown,
            span: 2,
            view: {
              type: "chart",
              config: {
                chartType: "horizontal_bar",
                groupBy: b.group,
                stackBy: b.side,
                chartAggregate: { fn: "sum", property: b.amount },
                chartSort: "value_desc",
                hideEmptyGroups: true,
                showValues: true,
                filters: [thisMonth],
              },
            },
          },
          {
            database: "balance",
            title: w.netWorthByDate,
            span: 2,
            view: {
              type: "chart",
              config: { chartType: "bar", groupBy: b.date, groupDateBy: "day", chartAggregate: { fn: "sum", property: b.net }, hideEmptyGroups: true, showValues: true },
            },
          },
        ],
      },
      {
        key: "customers",
        kind: "database",
        icon: "🤝",
        title: customers.title,
        properties: [
          {
            name: c.stage,
            type: "select",
            options: [
              { name: customers.stages.lead, color: "blue" },
              { name: customers.stages.prospect, color: "orange" },
              { name: customers.stages.customer, color: "green" },
              { name: customers.stages.inactive, color: "gray" },
            ],
          },
          // Filled in as cities are typed.
          { name: c.city, type: "select", options: [] },
          { name: c.contact, type: "text" },
          { name: c.phone, type: "phone" },
          { name: c.email, type: "email" },
          { name: c.nextStep, type: "text" },
          { name: c.nextStepDate, type: "date" },
          // Through the relation the quotes' customer property adds here.
          { name: c.quoted, type: "rollup", rollup: { relation: c.quotes, target: q.amount, fn: "sum" } },
        ],
        views: [
          { name: customers.table, type: "table", config: {} },
          { name: customers.board, type: "board", config: { groupBy: c.stage } },
        ],
      },
      {
        key: "quotes",
        kind: "database",
        icon: "🧾",
        title: quotes.title,
        properties: [
          { name: q.customer, type: "relation", relation: { database: "customers", pairedName: c.quotes } },
          {
            name: q.status,
            type: "status",
            options: [
              { name: quotes.statuses.draft, group: "todo" },
              { name: quotes.statuses.sent, group: "in_progress" },
              { name: quotes.statuses.revision, group: "in_progress", color: "orange" },
              { name: quotes.statuses.accepted, group: "done" },
              { name: quotes.statuses.lost, group: "done", color: "red" },
            ],
          },
          { name: q.amount, type: "number", number: money },
          // The first date: an open quote is listed under it for whoever prepared it (server/assigned).
          { name: q.followUp, type: "date" },
          { name: q.date, type: "date" },
          { name: q.validUntil, type: "date" },
          { name: q.preparedBy, type: "person" },
        ],
        views: [
          { name: quotes.table, type: "table", config: { sorts: [{ property: q.date, direction: "desc" }], calculations: { [q.amount]: "sum" } } },
          {
            name: quotes.board,
            type: "board",
            config: { groupBy: q.status, sorts: [{ property: q.date, direction: "desc" }], boardAggregate: { fn: "sum", property: q.amount } },
          },
          { name: quotes.calendar, type: "calendar", config: { dateBy: q.followUp } },
        ],
        rowTemplate: { ...quotes.rowTemplate, properties: { [q.status]: quotes.statuses.draft } },
      },
      {
        key: "jobs",
        kind: "database",
        icon: "🗂️",
        title: jobs.title,
        properties: [
          {
            name: j.status,
            type: "status",
            options: [
              { name: jobs.statuses.todo, group: "todo" },
              { name: jobs.statuses.waiting, group: "todo", color: "yellow" },
              { name: jobs.statuses.inProgress, group: "in_progress" },
              { name: jobs.statuses.done, group: "done" },
            ],
          },
          {
            name: j.priority,
            type: "select",
            options: [
              { name: jobs.priorities.urgent, color: "red" },
              { name: jobs.priorities.high, color: "orange" },
              { name: jobs.priorities.normal, color: "blue" },
              { name: jobs.priorities.low, color: "gray" },
            ],
          },
          { name: j.assignee, type: "person" },
          { name: j.due, type: "date" },
          { name: j.customer, type: "relation", relation: { database: "customers", pairedName: c.jobs } },
          { name: j.quote, type: "relation", relation: { database: "quotes", pairedName: q.jobs } },
          { name: j.notes, type: "text" },
        ],
        views: [
          { name: jobs.table, type: "table", config: { sorts: soonestFirst(j.due) } },
          { name: jobs.board, type: "board", config: { groupBy: j.status, sorts: soonestFirst(j.due) } },
          { name: jobs.byPerson, type: "board", config: { groupBy: j.assignee, filters: [jobOpen], sorts: soonestFirst(j.due) } },
          { name: jobs.calendar, type: "calendar", config: { dateBy: j.due } },
        ],
        rowTemplate: { ...jobs.rowTemplate, properties: { [j.status]: jobs.statuses.todo, [j.priority]: jobs.priorities.normal } },
      },
      {
        key: "balance",
        kind: "database",
        icon: "⚖️",
        title: balance.title,
        properties: [
          { name: b.date, type: "date" },
          {
            name: b.side,
            type: "select",
            options: [
              { name: balance.sides.asset, color: "green" },
              { name: balance.sides.liability, color: "red" },
            ],
          },
          { name: b.group, type: "select", options: Object.values(balance.groups).map((name) => ({ name })) },
          { name: b.amount, type: "number", number: money },
          // What an entry adds to the net worth: what is owed counts against it.
          {
            name: b.net,
            type: "formula",
            formula: `if(prop(${quote(b.side)}) == ${quote(balance.sides.liability)}, -prop(${quote(b.amount)}), prop(${quote(b.amount)}))`,
            number: money,
          },
          { name: b.note, type: "text" },
        ],
        views: [
          { name: balance.table, type: "table", config: { sorts: [{ property: b.date, direction: "desc" }] } },
          // One group per day counted, each with its net worth underneath.
          {
            name: balance.byDate,
            type: "table",
            config: {
              groupBy: b.date,
              groupDateBy: "day",
              sorts: [
                { property: b.side, direction: "asc" },
                { property: b.group, direction: "asc" },
                { property: b.amount, direction: "desc" },
              ],
              calculations: { [b.net]: "sum" },
            },
          },
          {
            name: balance.netWorth,
            type: "chart",
            config: { chartType: "bar", groupBy: b.date, groupDateBy: "day", chartAggregate: { fn: "sum", property: b.net }, hideEmptyGroups: true, showValues: true },
          },
          {
            name: balance.thisMonth,
            type: "chart",
            config: {
              chartType: "horizontal_bar",
              groupBy: b.group,
              stackBy: b.side,
              chartAggregate: { fn: "sum", property: b.amount },
              chartSort: "value_desc",
              hideEmptyGroups: true,
              showValues: true,
              filters: [thisMonth],
            },
          },
        ],
      },
      { key: "weekly-plan", kind: "page", icon: "🗓️", title: weeklyPlan.title, markdown: weeklyPlan.markdown },
    ],
  };
}
