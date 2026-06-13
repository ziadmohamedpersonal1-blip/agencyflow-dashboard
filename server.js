require("dotenv").config({ override: true });

const express = require("express");
const cors = require("cors");
const path = require("path");
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const useSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

const supabase = useSupabase
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  : null;

const emailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// -------------------- HELPERS --------------------

function requireDatabase() {
  if (!useSupabase || !supabase) {
    throw new Error("Missing Supabase environment variables");
  }
}

function cleanText(value) {
  return String(value || "").trim();
}

function cleanEmail(value) {
  return cleanText(value).toLowerCase();
}

function isValidEmail(email) {
  const clean = cleanEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean);
}

function makeClientKey(businessName) {
  const base = cleanText(businessName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const suffix = Date.now().toString().slice(-5);

  return `${base || "client"}-${suffix}`;
}

function calculateLeadScore(lead) {
  let score = 0;

  if (lead.lead_name) score += 15;
  if (lead.email) score += 15;
  if (lead.phone) score += 20;
  if (lead.service) score += 15;
  if (lead.source && lead.source !== "Manual") score += 10;
  if (lead.campaign) score += 10;
  if (lead.budget) score += 10;
  if (lead.message) score += 5;

  return Math.min(score, 100);
}

function calculatePriority(lead) {
  const text = `${lead.service || ""} ${lead.budget || ""} ${lead.message || ""}`.toLowerCase();

  if (
    text.includes("urgent") ||
    text.includes("asap") ||
    text.includes("today") ||
    text.includes("emergency") ||
    text.includes("this week")
  ) {
    return "High";
  }

  const budgetNumber = Number(String(lead.budget || "").replace(/[^0-9.]/g, ""));

  if (!Number.isNaN(budgetNumber) && budgetNumber >= 5000) {
    return "High";
  }

  if (!Number.isNaN(budgetNumber) && budgetNumber >= 1000) {
    return "Medium";
  }

  return "Normal";
}

function calculateSlaStatus(lead) {
  if (lead.first_response_sent || ["Booked", "Won", "Lost", "Closed"].includes(lead.status)) {
    return "Responded";
  }

  const createdAt = lead.created_at ? new Date(lead.created_at).getTime() : Date.now();
  const ageHours = (Date.now() - createdAt) / (1000 * 60 * 60);

  if (ageHours >= 24) {
    return "Overdue";
  }

  if (ageHours >= 2) {
    return "At Risk";
  }

  return "On Track";
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  return `"${String(value).replaceAll('"', '""')}"`;
}

function buildCsv(rows) {
  const headers = [
    "Lead ID",
    "Client",
    "Lead Name",
    "Email",
    "Phone",
    "Service",
    "Source",
    "Campaign",
    "Budget",
    "Status",
    "Priority",
    "SLA",
    "Lead Score",
    "First Response Sent",
    "Created At",
  ];

  const dataRows = rows.map((row) => [
    row.id,
    row.client_name || "",
    row.lead_name,
    row.email,
    row.phone,
    row.service,
    row.source,
    row.campaign,
    row.budget,
    row.status,
    row.priority,
    row.sla_status,
    row.lead_score,
    row.first_response_sent ? "Yes" : "No",
    row.created_at,
  ]);

  return [headers, ...dataRows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

async function addLog(entityType, entityId, action, details) {
  requireDatabase();

  await supabase.from("agency_logs").insert({
    entity_type: entityType,
    entity_id: Number(entityId),
    action,
    details: details || "",
  });
}

function buildLeadReplyEmail(lead, client) {
  return {
    subject: `${client.business_name} received your request`,
    body: `Hi ${lead.lead_name},

Thanks for contacting ${client.business_name} about ${lead.service || "your request"}.

We received your details and our team will follow up with you shortly.

Best regards,
${client.business_name}`,
  };
}

function buildClientReportEmail(client, leads) {
  const totalLeads = leads.length;
  const newLeads = leads.filter((lead) => lead.status === "New Lead").length;
  const contacted = leads.filter((lead) => lead.first_response_sent === true).length;
  const highPriority = leads.filter((lead) => lead.priority === "High").length;
  const overdue = leads.filter((lead) => lead.sla_status === "Overdue").length;
  const averageScore =
    totalLeads === 0
      ? 0
      : Math.round(leads.reduce((sum, lead) => sum + Number(lead.lead_score || 0), 0) / totalLeads);

  const lines = leads
    .slice(0, 10)
    .map((lead) => {
      return `- ${lead.lead_name} | ${lead.service || "No service"} | ${lead.status} | ${lead.priority} | Score: ${lead.lead_score}`;
    })
    .join("\n");

  return {
    subject: `AgencyFlow Report - ${client.business_name}`,
    body: `Hi ${client.owner_name || client.business_name},

Here is the latest lead report for ${client.business_name}.

Total leads: ${totalLeads}
New leads: ${newLeads}
Contacted leads: ${contacted}
High priority leads: ${highPriority}
Overdue follow-ups: ${overdue}
Average lead score: ${averageScore}/100

Latest leads:
${lines || "No leads yet."}

Best,
AgencyFlow Command Center`,
  };
}

// -------------------- DATABASE QUERIES --------------------

async function getClients() {
  requireDatabase();

  const { data, error } = await supabase
    .from("agency_clients")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

async function getClientById(id) {
  requireDatabase();

  const { data, error } = await supabase
    .from("agency_clients")
    .select("*")
    .eq("id", Number(id))
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

async function getLeads(filters = {}) {
  requireDatabase();

  let query = supabase
    .from("agency_leads")
    .select(
      `
      *,
      agency_clients (
        id,
        business_name,
        owner_name,
        owner_email,
        niche,
        crm_name
      )
    `
    )
    .order("created_at", { ascending: false });

  if (filters.client_id) {
    query = query.eq("client_id", Number(filters.client_id));
  }

  if (filters.status) {
    query = query.eq("status", filters.status);
  }

  if (filters.priority) {
    query = query.eq("priority", filters.priority);
  }

  if (filters.sla_status) {
    query = query.eq("sla_status", filters.sla_status);
  }

  const { data, error } = await query;

  if (error) throw new Error(error.message);

  let leads = data || [];

  if (filters.search) {
    const search = cleanText(filters.search).toLowerCase();

    leads = leads.filter((lead) => {
      return (
        cleanText(lead.lead_name).toLowerCase().includes(search) ||
        cleanText(lead.email).toLowerCase().includes(search) ||
        cleanText(lead.phone).toLowerCase().includes(search) ||
        cleanText(lead.service).toLowerCase().includes(search) ||
        cleanText(lead.campaign).toLowerCase().includes(search) ||
        cleanText(lead.agency_clients?.business_name).toLowerCase().includes(search)
      );
    });
  }

  return leads.map((lead) => ({
    ...lead,
    client_name: lead.agency_clients?.business_name || "",
    client_owner_email: lead.agency_clients?.owner_email || "",
  }));
}

async function getLeadById(id) {
  requireDatabase();

  const { data, error } = await supabase
    .from("agency_leads")
    .select(
      `
      *,
      agency_clients (
        id,
        business_name,
        owner_name,
        owner_email,
        niche,
        crm_name
      )
    `
    )
    .eq("id", Number(id))
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

async function refreshLeadSlaStatuses() {
  const leads = await getLeads({});

  for (const lead of leads) {
    const newSlaStatus = calculateSlaStatus(lead);

    if (newSlaStatus !== lead.sla_status) {
      await supabase
        .from("agency_leads")
        .update({
          sla_status: newSlaStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", lead.id);
    }
  }
}

// -------------------- ROUTES --------------------
app.post("/demo/seed", async (req, res) => {
  try {
    requireDatabase();

    const demoClients = [
      {
        client_key: `demo-roofing-${Date.now()}`,
        business_name: "Apex Roofing",
        niche: "Home Services",
        owner_name: "John Smith",
        owner_email: process.env.OWNER_EMAIL || process.env.EMAIL_USER,
        phone: "+1 555 123 4567",
        crm_name: "GoHighLevel",
        status: "Active",
        notes: "Demo agency client focused on roofing leads.",
        updated_at: new Date().toISOString(),
      },
      {
        client_key: `demo-landscaping-${Date.now()}`,
        business_name: "GreenPeak Landscaping",
        niche: "Landscaping",
        owner_name: "Sarah Miller",
        owner_email: process.env.OWNER_EMAIL || process.env.EMAIL_USER,
        phone: "+1 555 222 8899",
        crm_name: "HubSpot",
        status: "Active",
        notes: "Demo client for landscaping lead tracking.",
        updated_at: new Date().toISOString(),
      },
      {
        client_key: `demo-hvac-${Date.now()}`,
        business_name: "NorthStar HVAC",
        niche: "HVAC",
        owner_name: "Mike Anderson",
        owner_email: process.env.OWNER_EMAIL || process.env.EMAIL_USER,
        phone: "+1 555 777 1010",
        crm_name: "Not connected",
        status: "Active",
        notes: "Demo HVAC client with mixed lead priorities.",
        updated_at: new Date().toISOString(),
      },
    ];

    const { data: insertedClients, error: clientError } = await supabase
      .from("agency_clients")
      .insert(demoClients)
      .select("*");

    if (clientError) throw new Error(clientError.message);

    const findClient = (name) =>
      insertedClients.find((client) => client.business_name === name);

    const demoLeads = [
      {
        client_id: findClient("Apex Roofing").id,
        lead_name: "Michael Brown",
        email: `michael${Date.now()}@example.com`,
        phone: "+1 555 333 4444",
        service: "Emergency roof repair",
        source: "Facebook Ads",
        campaign: "June Roofing Leads",
        budget: "$4500",
        message: "Need urgent roof repair this week after storm damage.",
        status: "New Lead",
      },
      {
        client_id: findClient("Apex Roofing").id,
        lead_name: "Emily Carter",
        email: `emily${Date.now()}@example.com`,
        phone: "+1 555 444 2222",
        service: "Roof replacement estimate",
        source: "Google Ads",
        campaign: "Roof Replacement Search",
        budget: "$12000",
        message: "Looking for a full roof replacement quote.",
        status: "Qualified",
      },
      {
        client_id: findClient("GreenPeak Landscaping").id,
        lead_name: "David Wilson",
        email: `david${Date.now()}@example.com`,
        phone: "+1 555 810 9000",
        service: "Backyard design",
        source: "Landing Page",
        campaign: "Summer Backyard Campaign",
        budget: "$8000",
        message: "Interested in patio, fire pit, and landscaping design.",
        status: "Booked",
      },
      {
        client_id: findClient("GreenPeak Landscaping").id,
        lead_name: "Amanda Lee",
        email: `amanda${Date.now()}@example.com`,
        phone: "+1 555 202 3000",
        service: "Patio installation",
        source: "Instagram",
        campaign: "Outdoor Living Offer",
        budget: "$3500",
        message: "Wants pricing for patio installation this month.",
        status: "Contacted",
      },
      {
        client_id: findClient("NorthStar HVAC").id,
        lead_name: "Robert Evans",
        email: `robert${Date.now()}@example.com`,
        phone: "+1 555 900 4040",
        service: "AC repair",
        source: "Website Form",
        campaign: "AC Repair Form",
        budget: "$700",
        message: "AC stopped working today. Needs help ASAP.",
        status: "New Lead",
      },
      {
        client_id: findClient("NorthStar HVAC").id,
        lead_name: "Laura White",
        email: `laura${Date.now()}@example.com`,
        phone: "+1 555 600 9191",
        service: "HVAC maintenance plan",
        source: "Referral",
        campaign: "Referral Lead",
        budget: "$1200",
        message: "Interested in annual maintenance plan.",
        status: "Won",
      },
    ];

    const scoredLeads = demoLeads.map((lead) => {
      const leadScore = calculateLeadScore(lead);
      const priority = calculatePriority(lead);

      return {
        ...lead,
        lead_score: leadScore,
        priority,
        sla_status: "On Track",
        first_response_sent: ["Contacted", "Booked", "Qualified", "Won"].includes(lead.status),
        email_sent: false,
        updated_at: new Date().toISOString(),
      };
    });

    const { data: insertedLeads, error: leadError } = await supabase
      .from("agency_leads")
      .insert(scoredLeads)
      .select("*");

    if (leadError) throw new Error(leadError.message);

    for (const client of insertedClients) {
      await addLog("client", client.id, "Demo client created", `${client.business_name} was added as demo data`);
    }

    for (const lead of insertedLeads) {
      await addLog("lead", lead.id, "Demo lead created", `${lead.lead_name} was added as demo lead`);
    }

    res.status(201).json({
      success: true,
      message: "Demo data loaded successfully",
      clients: insertedClients.length,
      leads: insertedLeads.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load demo data",
      error: error.message,
    });
  }
});
app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",
    database: useSupabase ? "Supabase" : "Missing Supabase config",
    message: "AgencyFlow server is running",
  });
});

app.get("/dashboard", async (req, res) => {
  try {
    await refreshLeadSlaStatuses();

    const clients = await getClients();
    const leads = await getLeads({});

    const totalClients = clients.length;
    const activeClients = clients.filter((client) => client.status === "Active").length;
    const totalLeads = leads.length;
    const newLeads = leads.filter((lead) => lead.status === "New Lead").length;
    const highPriorityLeads = leads.filter((lead) => lead.priority === "High").length;
    const overdueLeads = leads.filter((lead) => lead.sla_status === "Overdue").length;
    const respondedLeads = leads.filter((lead) => lead.first_response_sent === true).length;

    const averageScore =
      totalLeads === 0
        ? 0
        : Math.round(leads.reduce((sum, lead) => sum + Number(lead.lead_score || 0), 0) / totalLeads);

    const byClient = clients.map((client) => {
      const clientLeads = leads.filter((lead) => Number(lead.client_id) === Number(client.id));

      return {
        id: client.id,
        business_name: client.business_name,
        niche: client.niche,
        owner_email: client.owner_email,
        total_leads: clientLeads.length,
        new_leads: clientLeads.filter((lead) => lead.status === "New Lead").length,
        high_priority: clientLeads.filter((lead) => lead.priority === "High").length,
        overdue: clientLeads.filter((lead) => lead.sla_status === "Overdue").length,
        average_score:
          clientLeads.length === 0
            ? 0
            : Math.round(
                clientLeads.reduce((sum, lead) => sum + Number(lead.lead_score || 0), 0) /
                  clientLeads.length
              ),
      };
    });

    res.json({
      success: true,
      data: {
        totalClients,
        activeClients,
        totalLeads,
        newLeads,
        highPriorityLeads,
        overdueLeads,
        respondedLeads,
        averageScore,
        byClient,
        latestLeads: leads.slice(0, 8),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load dashboard",
      error: error.message,
    });
  }
});

app.get("/clients", async (req, res) => {
  try {
    const clients = await getClients();

    res.json({
      success: true,
      count: clients.length,
      data: clients,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load clients",
      error: error.message,
    });
  }
});

app.post("/clients", async (req, res) => {
  try {
    requireDatabase();

    const businessName = cleanText(req.body.business_name);
    const ownerEmail = cleanEmail(req.body.owner_email);

    if (!businessName) {
      return res.status(400).json({
        success: false,
        message: "Business name is required",
      });
    }

    if (ownerEmail && !isValidEmail(ownerEmail)) {
      return res.status(400).json({
        success: false,
        message: "Invalid owner email",
      });
    }

    const clientPayload = {
      client_key: makeClientKey(businessName),
      business_name: businessName,
      niche: cleanText(req.body.niche),
      owner_name: cleanText(req.body.owner_name),
      owner_email: ownerEmail,
      phone: cleanText(req.body.phone),
      crm_name: cleanText(req.body.crm_name) || "Not connected",
      status: cleanText(req.body.status) || "Active",
      notes: cleanText(req.body.notes),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("agency_clients")
      .insert(clientPayload)
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    await addLog("client", data.id, "Client created", `${data.business_name} was added to AgencyFlow`);

    res.status(201).json({
      success: true,
      message: "Client created successfully",
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to create client",
      error: error.message,
    });
  }
});

app.get("/clients/:id", async (req, res) => {
  try {
    const client = await getClientById(req.params.id);

    if (!client) {
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    const leads = await getLeads({ client_id: client.id });

    res.json({
      success: true,
      data: {
        client,
        leads,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load client",
      error: error.message,
    });
  }
});

app.get("/leads", async (req, res) => {
  try {
    await refreshLeadSlaStatuses();

    const leads = await getLeads(req.query);

    res.json({
      success: true,
      count: leads.length,
      filters: {
        client_id: req.query.client_id || null,
        status: req.query.status || null,
        priority: req.query.priority || null,
        sla_status: req.query.sla_status || null,
        search: req.query.search || null,
      },
      data: leads,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load leads",
      error: error.message,
    });
  }
});

app.post("/leads", async (req, res) => {
  try {
    requireDatabase();

    const clientId = Number(req.body.client_id);
    const client = await getClientById(clientId);

    if (!client) {
      return res.status(400).json({
        success: false,
        message: "Valid client is required",
      });
    }

    const leadName = cleanText(req.body.lead_name);
    const email = cleanEmail(req.body.email);
    const phone = cleanText(req.body.phone);

    if (!leadName || !phone) {
      return res.status(400).json({
        success: false,
        message: "Lead name and phone are required",
      });
    }

    if (email && !isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid lead email",
      });
    }

    if (email) {
      const { data: existingLead, error: duplicateError } = await supabase
        .from("agency_leads")
        .select("*")
        .eq("client_id", clientId)
        .eq("email", email)
        .maybeSingle();

      if (duplicateError) throw new Error(duplicateError.message);

      if (existingLead) {
        await addLog(
          "lead",
          existingLead.id,
          "Duplicate lead blocked",
          `Duplicate email ${email} blocked for ${client.business_name}`
        );

        return res.status(409).json({
          success: false,
          message: "Duplicate lead blocked for this client",
          existingLeadId: existingLead.id,
          data: existingLead,
        });
      }
    }

    const rawLead = {
      lead_name: leadName,
      email,
      phone,
      service: cleanText(req.body.service),
      source: cleanText(req.body.source) || "Manual",
      campaign: cleanText(req.body.campaign),
      budget: cleanText(req.body.budget),
      message: cleanText(req.body.message),
      status: cleanText(req.body.status) || "New Lead",
    };

    const leadScore = calculateLeadScore(rawLead);
    const priority = calculatePriority(rawLead);

    const insertPayload = {
      client_id: clientId,
      ...rawLead,
      priority,
      lead_score: leadScore,
      sla_status: "On Track",
      first_response_sent: false,
      email_sent: false,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("agency_leads")
      .insert(insertPayload)
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    await addLog("lead", data.id, "Lead received", `New lead added for ${client.business_name}`);
    await addLog("lead", data.id, "Lead scored", `Score: ${leadScore}/100 - Priority: ${priority}`);
    await addLog("client", client.id, "Client lead added", `${data.lead_name} added as a new lead`);

    res.status(201).json({
      success: true,
      message: "Lead created, scored, and saved successfully",
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to create lead",
      error: error.message,
    });
  }
});

app.get("/leads/:id", async (req, res) => {
  try {
    const lead = await getLeadById(req.params.id);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    res.json({
      success: true,
      data: lead,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load lead",
      error: error.message,
    });
  }
});

app.put("/leads/:id/status", async (req, res) => {
  try {
    requireDatabase();

    const lead = await getLeadById(req.params.id);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    const newStatus = cleanText(req.body.status);

    if (!newStatus) {
      return res.status(400).json({
        success: false,
        message: "Status is required",
      });
    }

    const firstResponseSent =
      lead.first_response_sent ||
      ["Contacted", "Booked", "Qualified", "Won", "Lost"].includes(newStatus);

    const updatePayload = {
      status: newStatus,
      first_response_sent: firstResponseSent,
      sla_status: firstResponseSent ? "Responded" : calculateSlaStatus(lead),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("agency_leads")
      .update(updatePayload)
      .eq("id", Number(req.params.id))
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    await addLog("lead", data.id, "Status updated", `Status changed from ${lead.status} to ${newStatus}`);

    res.json({
      success: true,
      message: "Lead status updated successfully",
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update lead status",
      error: error.message,
    });
  }
});

app.post("/leads/:id/send-email", async (req, res) => {
  try {
    requireDatabase();

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      return res.status(500).json({
        success: false,
        message: "Email credentials are missing",
      });
    }

    const lead = await getLeadById(req.params.id);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    if (!lead.email) {
      return res.status(400).json({
        success: false,
        message: "Lead has no email address",
      });
    }

    const client = lead.agency_clients;

    if (!client) {
      return res.status(400).json({
        success: false,
        message: "Lead client data is missing",
      });
    }

    const draft = buildLeadReplyEmail(lead, client);

    await emailTransporter.sendMail({
      from: `"AgencyFlow Command Center" <${process.env.EMAIL_USER}>`,
      to: lead.email,
      subject: draft.subject,
      text: draft.body,
    });

    const { data, error } = await supabase
      .from("agency_leads")
      .update({
        email_sent: true,
        email_sent_at: new Date().toISOString(),
        first_response_sent: true,
        status: lead.status === "New Lead" ? "Contacted" : lead.status,
        sla_status: "Responded",
        updated_at: new Date().toISOString(),
      })
      .eq("id", Number(lead.id))
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    await addLog("lead", lead.id, "Lead email sent", `Real email sent to ${lead.email}`);

    res.json({
      success: true,
      message: "Email sent to lead successfully",
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to send lead email",
      error: error.message,
    });
  }
});

app.post("/clients/:id/send-report", async (req, res) => {
  try {
    requireDatabase();

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      return res.status(500).json({
        success: false,
        message: "Email credentials are missing",
      });
    }

    const client = await getClientById(req.params.id);

    if (!client) {
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    if (!client.owner_email) {
      return res.status(400).json({
        success: false,
        message: "Client has no owner email",
      });
    }

    const leads = await getLeads({ client_id: client.id });
    const report = buildClientReportEmail(client, leads);

    await emailTransporter.sendMail({
      from: `"AgencyFlow Reports" <${process.env.EMAIL_USER}>`,
      to: client.owner_email,
      subject: report.subject,
      text: report.body,
    });

    await addLog("client", client.id, "Client report sent", `Report sent to ${client.owner_email}`);

    res.json({
      success: true,
      message: "Client report sent successfully",
      data: {
        client,
        sent_to: client.owner_email,
        total_leads: leads.length,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to send client report",
      error: error.message,
    });
  }
});

app.get("/logs", async (req, res) => {
  try {
    requireDatabase();

    let query = supabase
      .from("agency_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);

    if (req.query.entity_type) {
      query = query.eq("entity_type", req.query.entity_type);
    }

    if (req.query.entity_id) {
      query = query.eq("entity_id", Number(req.query.entity_id));
    }

    const { data, error } = await query;

    if (error) throw new Error(error.message);

    res.json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load logs",
      error: error.message,
    });
  }
});

app.get("/export/csv", async (req, res) => {
  try {
    const leads = await getLeads(req.query);
    const csv = buildCsv(leads);

    res.setHeader("Content-Type", "text/csv;charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="agencyflow-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to export CSV",
      error: error.message,
    });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AgencyFlow server running on port ${PORT}`);
    console.log(`Database mode: ${useSupabase ? "Supabase" : "Missing Supabase config"}`);
  });
}

module.exports = app;