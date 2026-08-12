const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "ngrok-skip-browser-warning",
    ],
  }),
);

app.use(express.json({ limit: "1mb" }));

// ============================================================
// REQUEST LOGGING
// ============================================================

app.use((req, res, next) => {
  const start = Date.now();

  console.log("\n" + "=".repeat(60));
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  console.log("Raw body keys:", Object.keys(req.body || {}));

  if (req.body && Object.keys(req.body).length > 0) {
    console.log("Request body:", JSON.stringify(maskPII(req.body)));
  }

  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`Response: ${res.statusCode} | ${duration}ms`);
  });

  next();
});

// ============================================================
// MOCK CUSTOMER DATABASE
// ============================================================

const customers = new Map([
  [
    "ACC-88392",
    {
      account_id: "ACC-88392",
      verification_codes: ["1234", "1995"],
      name: "Rahul Sharma",
      loan_type: "Personal Loan",
      overdue_amount: 8499,
      days_overdue: 12,
      due_date: "2026-07-31",
      registered_phone: "+91XXXXXXXXXX",
    },
  ],
  [
    "ACC-10001",
    {
      account_id: "ACC-10001",
      verification_codes: ["5678", "1990"],
      name: "Priya Mehta",
      loan_type: "Home Loan",
      overdue_amount: 15000,
      days_overdue: 45,
      due_date: "2026-06-28",
      registered_phone: "+91XXXXXXXXXX",
    },
  ],
  [
    "ACC-20002",
    {
      account_id: "ACC-20002",
      verification_codes: ["4321", "1988"],
      name: "Arjun Kumar",
      loan_type: "Personal Loan",
      overdue_amount: 6200,
      days_overdue: 18,
      due_date: "2026-07-25",
      registered_phone: "+91XXXXXXXXXX",
    },
  ],
]);

// STATE
const verificationTracker = new Map();
const callHistory = [];
const ptpHistory = [];
const paymentHistory = [];
const escalationHistory = [];

// CONSTANTS
const MAX_ATTEMPTS = 3;

const VALID_DISPOSITIONS = [
  "PTP_AGREED",
  "ALREADY_PAID",
  "DISPUTED",
  "HARDSHIP_ESCALATED",
  "WRONG_PERSON",
  "DO_NOT_CALL",
  "NO_RESPONSE",
];

const VALID_PAYMENT_CHANNELS = ["SMS", "WHATSAPP", "BOTH"];

const VALID_ESCALATION_REASONS = [
  "HARDSHIP_REQUEST",
  "DISPUTE",
  "COMPLAINT",
  "CUSTOMER_REQUEST",
];

const VALID_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];

// HELPERS
function generateId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .substring(2, 7)}`;
}

function maskPII(data) {
  const masked = JSON.parse(JSON.stringify(data || {}));

  if (masked.verification_code) {
    masked.verification_code = "****";
  }

  if (masked.verification_codes) {
    masked.verification_codes = ["****"];
  }

  if (masked.account_id) {
    const value = String(masked.account_id);
    if (value.length > 4) {
      masked.account_id =
        value.substring(0, 4) + "XX" + value.substring(value.length - 2);
    }
  }

  return masked;
}

function getCustomer(accountId) {
  if (!accountId) return null;
  return customers.get(String(accountId));
}

function getVerificationAttempts(accountId) {
  return verificationTracker.get(accountId) || 0;
}

function setVerificationAttempts(accountId, attempts) {
  verificationTracker.set(accountId, attempts);
}

function resolveAccountId(accountId) {
  if (!accountId) return "ACC-88392";

  const id = String(accountId).trim();

  if (
    id === "{{account_id}}" ||
    id === "CURRENT_ACCOUNT_ID" ||
    id.includes("{{")
  ) {
    return "ACC-88392";
  }

  return id;
}

function normalizeArgs(args) {
  const normalized = {};
  for (const key in args) {
    const cleanKey = key.replace(/\n/g, "").trim();
    normalized[cleanKey] = args[key];
  }
  return normalized;
}

// TOOL IMPLEMENTATIONS
const toolHandlers = {
  verify_customer: (args = {}) => {
    args = normalizeArgs(args);
    const accountId = resolveAccountId(args.account_id);
    const verificationCode = String(args.verification_code || "").trim();

    if (!accountId || !verificationCode) {
      return {
        verified: false,
        message: "account_id and verification_code are required.",
        attempts_remaining: 0,
      };
    }

    const customer = getCustomer(accountId);

    if (!customer) {
      return {
        verified: false,
        message: "Customer account could not be found.",
        attempts_remaining: 0,
      };
    }

    const attempts = getVerificationAttempts(accountId);

    if (attempts >= MAX_ATTEMPTS) {
      return {
        verified: false,
        message:
          "Maximum verification attempts reached. Please contact customer service.",
        attempts_made: attempts,
        attempts_remaining: 0,
        locked: true,
      };
    }

    const isValid = customer.verification_codes.includes(verificationCode);

    if (isValid) {
      setVerificationAttempts(accountId, 0);
      return {
        verified: true,
        message: "Identity verified successfully.",
        customer: {
          name: customer.name,
          loan_type: customer.loan_type,
          overdue_amount: customer.overdue_amount,
          days_overdue: customer.days_overdue,
          due_date: customer.due_date,
        },
        attempts_remaining: MAX_ATTEMPTS,
      };
    }

    const newAttempts = attempts + 1;
    setVerificationAttempts(accountId, newAttempts);
    const remaining = Math.max(0, MAX_ATTEMPTS - newAttempts);

    return {
      verified: false,
      message:
        remaining > 0
          ? "Verification failed. Please try again."
          : "Maximum verification attempts reached. Please contact customer service.",
      attempts_made: newAttempts,
      attempts_remaining: remaining,
      locked: remaining === 0,
    };
  },

  log_promise_to_pay: (args = {}) => {
    args = normalizeArgs(args);
    const accountId = resolveAccountId(args.account_id);
    const ptpDate = String(args.ptp_date || "").trim();
    const amount = Number(args.amount);
    const paymentMethod = args.payment_method
      ? String(args.payment_method)
      : "Not Specified";

    if (!accountId) {
      return { success: false, error: "account_id is required." };
    }

    if (!ptpDate) {
      return { success: false, error: "ptp_date is required." };
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return {
        success: false,
        error: "amount must be a valid positive number.",
      };
    }

    const customer = getCustomer(accountId);
    if (!customer) {
      return { success: false, error: "Customer account not found." };
    }

    const ptpId = generateId("PTP");
    const record = {
      success: true,
      ptp_id: ptpId,
      account_id: accountId,
      ptp_date: ptpDate,
      amount,
      payment_method: paymentMethod,
      reference_number: `KAPT-${ptpId}`,
      logged_at: new Date().toISOString(),
    };

    ptpHistory.push(record);
    return record;
  },

  send_payment_link: (args = {}) => {
    args = normalizeArgs(args);
    const accountId = resolveAccountId(args.account_id);
    const channel = String(args.channel || "SMS").toUpperCase();

    if (!accountId) {
      return { success: false, error: "account_id is required." };
    }

    const customer = getCustomer(accountId);
    if (!customer) {
      return { success: false, error: "Customer account not found." };
    }

    if (!VALID_PAYMENT_CHANNELS.includes(channel)) {
      return {
        success: false,
        error: "Invalid channel. Use SMS, WHATSAPP, or BOTH.",
      };
    }

    const transactionId = generateId("TXN");
    const channelText = channel === "BOTH" ? "SMS and WhatsApp" : channel;

    const result = {
      success: true,
      transaction_id: transactionId,
      account_id: accountId,
      channel,
      message: `Payment link sent successfully via ${channelText}.`,
      link_validity_hours: 24,
      estimated_delivery_seconds: 5,
      sent_at: new Date().toISOString(),
    };

    paymentHistory.push(result);
    return result;
  },

  mark_disposition: (args = {}) => {
    args = normalizeArgs(args);
    const accountId = resolveAccountId(args.account_id);
    const status = String(args.status || "").trim();
    const notes = String(args.notes || "");

    if (!accountId) {
      return { success: false, error: "account_id is required." };
    }

    if (!VALID_DISPOSITIONS.includes(status)) {
      return {
        success: false,
        error: `Invalid disposition. Allowed values: ${VALID_DISPOSITIONS.join(", ")}`,
      };
    }

    const customer = getCustomer(accountId);
    if (!customer) {
      return { success: false, error: "Customer account not found." };
    }

    const disposition = {
      success: true,
      disposition_logged: status,
      account_id: accountId,
      notes,
      timestamp: new Date().toISOString(),
    };

    callHistory.push({
      ...disposition,
      call_duration: "simulated",
    });

    return disposition;
  },

  escalate_to_agent: (args = {}) => {
    args = normalizeArgs(args);
    const accountId = resolveAccountId(args.account_id);
    const reason = String(args.reason || "").trim();
    const priority = String(args.priority || "MEDIUM").toUpperCase();
    const notes = String(args.notes || "");

    if (!accountId) {
      return { success: false, error: "account_id is required." };
    }

    if (!VALID_ESCALATION_REASONS.includes(reason)) {
      return {
        success: false,
        error: `Invalid escalation reason. Allowed values: ${VALID_ESCALATION_REASONS.join(", ")}`,
      };
    }

    if (!VALID_PRIORITIES.includes(priority)) {
      return {
        success: false,
        error: `Invalid priority. Allowed values: ${VALID_PRIORITIES.join(", ")}`,
      };
    }

    const customer = getCustomer(accountId);
    if (!customer) {
      return { success: false, error: "Customer account not found." };
    }

    const ticketId = generateId("ESC");
    const teams = {
      HARDSHIP_REQUEST: "Financial Counseling Team",
      DISPUTE: "Dispute Resolution Desk",
      COMPLAINT: "Grievance Officer",
      CUSTOMER_REQUEST: "Customer Service",
    };

    const callbackMinutes =
      priority === "URGENT" ? 5 : priority === "HIGH" ? 15 : 30;

    const result = {
      success: true,
      ticket_id: ticketId,
      account_id: accountId,
      reason,
      assigned_team: teams[reason] || "General Support",
      priority,
      estimated_callback_minutes: callbackMinutes,
      notes,
      created_at: new Date().toISOString(),
    };

    escalationHistory.push(result);
    return result;
  },
};

// ============================================================
// REQUEST DETECTION
// ============================================================

function detectDirectTool(body) {
  const args = normalizeArgs(body);

  if (args.account_id && args.verification_code !== undefined) {
    return "verify_customer";
  }
  if (args.account_id && args.ptp_date && args.amount !== undefined) {
    return "log_promise_to_pay";
  }
  if (args.account_id && args.channel) {
    return "send_payment_link";
  }
  if (args.account_id && args.status) {
    return "mark_disposition";
  }
  if (args.account_id && args.reason) {
    return "escalate_to_agent";
  }
  return null;
}

// ============================================================
// MAIN WEBHOOK
// ============================================================

app.post("/webhook", (req, res) => {
  try {
    const body = req.body || {};

    console.log("\n=== FULL REQUEST DEBUG ===");
    console.log("Body type:", typeof body);
    console.log("Body keys:", Object.keys(body));
    console.log("Body stringified:", JSON.stringify(body).substring(0, 1000));
    console.log("=== END DEBUG ===\n");

    const directTool = detectDirectTool(body);
    if (directTool) {
      console.log(`Direct API tool: ${directTool}`);
      const handler = toolHandlers[directTool];

      if (!handler) {
        return res.status(500).json({
          success: false,
          error: `Tool handler not found: ${directTool}`,
        });
      }

      const result = handler(body);
      console.log(`Tool result: ${JSON.stringify(result).substring(0, 500)}`);
      return res.status(200).json(result);
    }

    const message = body.message;
    if (!message) {
      console.log("No message wrapper and no direct tool detected");
      console.log("Full body for debugging:", JSON.stringify(body));
      return res.status(200).json({ status: "acknowledged" });
    }

    console.log(`Message type: ${message.type}`);
    console.log("Message keys:", Object.keys(message));

    if (message.type === "tool-calls") {
      if (!message.toolCalls || !message.toolCalls[0]) {
        return res.status(200).json({
          results: [
            {
              toolCallId: "unknown",
              result: JSON.stringify({
                success: false,
                error: "Invalid tool call structure",
              }),
            },
          ],
        });
      }

      const results = [];
      for (const toolCall of message.toolCalls) {
        const functionData = toolCall.function || {};
        const toolName = functionData.name;

        let args = functionData.arguments || {};
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }

        console.log(`Tool Call: ${toolName}`);
        console.log(`Arguments: ${JSON.stringify(maskPII(args))}`);

        const handler = toolHandlers[toolName];
        let result;

        if (!handler) {
          result = { success: false, error: `Unknown function: ${toolName}` };
        } else {
          result = handler(args);
        }

        console.log(`Tool result: ${JSON.stringify(result).substring(0, 500)}`);

        results.push({
          toolCallId: toolCall.id,
          result: typeof result === "string" ? result : JSON.stringify(result),
        });
      }

      return res.status(200).json({ results });
    }

    const fallbackTool = detectDirectTool(message);
    if (fallbackTool) {
      console.log(`Fallback direct tool: ${fallbackTool}`);
      const handler = toolHandlers[fallbackTool];
      if (handler) {
        const result = handler(message);
        return res.status(200).json({
          results: [
            {
              toolCallId: "fallback_" + Date.now(),
              result: JSON.stringify(result),
            },
          ],
        });
      }
    }

    console.log("Trying ultimate fallback...");
    const bodyStr = JSON.stringify(body);

    if (bodyStr.includes("send_payment_link")) {
      console.log("Found send_payment_link in body, extracting args...");
      const args = normalizeArgs(message);
      const result = toolHandlers.send_payment_link(args);
      return res.status(200).json({
        results: [
          {
            toolCallId: "ultimate_fallback_" + Date.now(),
            result: JSON.stringify(result),
          },
        ],
      });
    }

    if (bodyStr.includes("log_promise_to_pay")) {
      console.log("Found log_promise_to_pay in body, extracting args...");
      const args = normalizeArgs(message);
      const result = toolHandlers.log_promise_to_pay(args);
      return res.status(200).json({
        results: [
          {
            toolCallId: "ultimate_fallback_" + Date.now(),
            result: JSON.stringify(result),
          },
        ],
      });
    }

    if (message.type === "transcript") {
      console.log(`Transcript: ${(message.transcript || "").substring(0, 150)}`);
      return res.status(200).json({ status: "transcript_received" });
    }

    if (message.type === "speech-update") {
      console.log(`Speech status: ${message.status}`);
      return res.status(200).json({ status: "speech_update_received" });
    }

    if (message.type === "hang") {
      console.log(`Call ended: ${message.reason || "unknown"}`);
      return res.status(200).json({ status: "hang_received" });
    }

    return res.status(200).json({ status: "acknowledged" });
  } catch (error) {
    console.error("Webhook error:", error);
    console.error(error.stack);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error.message,
    });
  }
});

// ============================================================
// UTILITY ENDPOINTS
// ============================================================

app.get("/health", (req, res) => {
  const totalCalls = callHistory.length;
  const ptpAgreed = callHistory.filter(c => c.disposition_logged === "PTP_AGREED").length;
  const escalated = callHistory.filter(c => 
    ["DISPUTED", "HARDSHIP_ESCALATED"].includes(c.disposition_logged)
  ).length;
  const resolved = callHistory.filter(c => 
    ["PTP_AGREED", "ALREADY_PAID"].includes(c.disposition_logged)
  ).length;

  res.json({
    status: "healthy",
    service: "kapture-collections-mock-server",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage().heapUsed,
    customers: customers.size,
    active_verification_trackers: verificationTracker.size,
    total_ptps: ptpHistory.length,
    total_payments: paymentHistory.length,
    total_dispositions: callHistory.length,
    total_escalations: escalationHistory.length,
    containment_rate: totalCalls > 0 ? ((totalCalls - escalated) / totalCalls * 100).toFixed(1) + "%" : "0%",
    ptp_rate: totalCalls > 0 ? (ptpAgreed / totalCalls * 100).toFixed(1) + "%" : "0%",
    fcr_rate: totalCalls > 0 ? (resolved / totalCalls * 100).toFixed(1) + "%" : "0%",
  });
});

app.get("/metrics", (req, res) => {
  const totalCalls = callHistory.length;
  const ptpAgreed = callHistory.filter(c => c.disposition_logged === "PTP_AGREED").length;
  const escalated = callHistory.filter(c => 
    ["DISPUTED", "HARDSHIP_ESCALATED"].includes(c.disposition_logged)
  ).length;
  const resolved = callHistory.filter(c => 
    ["PTP_AGREED", "ALREADY_PAID"].includes(c.disposition_logged)
  ).length;

  res.json({
    total_calls: totalCalls,
    total_ptps: ptpHistory.length,
    total_dispositions: callHistory.length,
    total_escalations: escalationHistory.length,
    containment_rate: totalCalls > 0 ? ((totalCalls - escalated) / totalCalls * 100).toFixed(1) + "%" : "0%",
    ptp_rate: totalCalls > 0 ? (ptpAgreed / totalCalls * 100).toFixed(1) + "%" : "0%",
    fcr_rate: totalCalls > 0 ? (resolved / totalCalls * 100).toFixed(1) + "%" : "0%",
    dispositions: callHistory.map(c => ({
      status: c.disposition_logged,
      timestamp: c.timestamp
    }))
  });
});

app.get("/calls", (req, res) => {
  const maskedHistory = callHistory.map((call) => ({
    ...call,
    account_id: call.account_id
      ? maskPII({ account_id: call.account_id }).account_id
      : call.account_id,
  }));

  res.json({ total_calls: maskedHistory.length, calls: maskedHistory });
});

app.get("/ptps", (req, res) => {
  res.json({ total_ptps: ptpHistory.length, ptps: ptpHistory });
});

app.get("/payments", (req, res) => {
  res.json({ total_payments: paymentHistory.length, payments: paymentHistory });
});

app.get("/escalations", (req, res) => {
  res.json({
    total_escalations: escalationHistory.length,
    escalations: escalationHistory,
  });
});

app.get("/customers", (req, res) => {
  const safeCustomers = Array.from(customers.values()).map((customer) => ({
    account_id: customer.account_id,
    name: customer.name,
    loan_type: customer.loan_type,
    overdue_amount: customer.overdue_amount,
    days_overdue: customer.days_overdue,
    due_date: customer.due_date,
  }));

  res.json({ total_customers: safeCustomers.length, customers: safeCustomers });
});

app.post("/reset", (req, res) => {
  verificationTracker.clear();
  callHistory.length = 0;
  ptpHistory.length = 0;
  paymentHistory.length = 0;
  escalationHistory.length = 0;

  res.json({
    success: true,
    message: "All demo state reset.",
    timestamp: new Date().toISOString(),
  });
});

app.post("/test/:tool", (req, res) => {
  const toolName = req.params.tool;
  const args = req.body || {};

  const handler = toolHandlers[toolName];
  if (!handler) {
    return res.status(400).json({
      success: false,
      error: `Unknown tool: ${toolName}`,
      available_tools: Object.keys(toolHandlers),
    });
  }

  const start = Date.now();
  try {
    const result = handler(args);
    return res.json({
      tool: toolName,
      args: maskPII(args),
      result,
      response_time_ms: Date.now() - start,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: `Endpoint ${req.method} ${req.path} does not exist`,
    available_endpoints: [
      "POST /webhook",
      "GET /health",
      "GET /metrics",
      "GET /customers",
      "GET /calls",
      "GET /ptps",
      "GET /payments",
      "GET /escalations",
      "POST /reset",
      "POST /test/:tool",
    ],
  });
});

// START SERVER
app.listen(PORT, () => {
  console.clear();
  console.log(` Status: Running Port: ${PORT} Environment: ${process.env.NODE_ENV || "development"}
`);
});

process.on("SIGINT", () => {
  console.log("\nShutting down server...");
  console.log(`Total PTPs: ${ptpHistory.length}`);
  console.log(`Total payments: ${paymentHistory.length}`);
  console.log(`Total dispositions: ${callHistory.length}`);
  console.log(`Total escalations: ${escalationHistory.length}`);
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});