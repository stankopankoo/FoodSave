const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const Stripe = require("stripe");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/foodsave";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "";
const PUBLIC_LOGO_URL = process.env.PUBLIC_LOGO_URL || "";

const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

const PACKAGE_CATALOG = {
  fresh: { name: "Cerstve pecivo", priceCents: 1000 },
  fruit: { name: "Ovocny box", priceCents: 1000 },
  pastry: { name: "Cukrarsky vyber", priceCents: 1000 },
  surprise: { name: "Surprise box", priceCents: 800 },
};

const reservationSchema = new mongoose.Schema(
  {
    items: [
      {
        packageId: String,
        packageName: String,
        unitPriceCents: Number,
        quantity: Number,
      },
    ],
    totalCents: Number,
    address: String,
    pickupTime: String,
    pickupDate: String,
    customerName: String,
    phone: String,
    email: String,
    specialRequests: String,
    status: { type: String, default: "pending" },
    stripeSessionId: String,
    stripePaymentIntentId: String,
  },
  { timestamps: true }
);

const Reservation = mongoose.model("Reservation", reservationSchema);
const resendClient = RESEND_API_KEY
  ? new (require("resend").Resend)(RESEND_API_KEY)
  : null;

const formatEuro = (cents = 0) =>
  `${(cents / 100).toFixed(2).replace(".", ",")} €`;

const formatItemsList = (items = []) =>
  items
    .map((item) => `${item.packageName} × ${item.quantity}`)
    .join(", ");

const buildItemsTableRows = (items = []) =>
  items
    .map(
      (item) => `
        <tr>
          <td style="padding:6px 0; color:#5c6b63;">${item.packageName}</td>
          <td style="padding:6px 0; font-weight:700; text-align:right;">${item.quantity}×</td>
        </tr>
      `
    )
    .join("");

const partnerSignupSchema = new mongoose.Schema(
  {
    companyName: String,
    businessType: String,
    contactName: String,
    email: String,
    city: String,
    phone: String,
  },
  { timestamps: true }
);

const PartnerSignup = mongoose.model("PartnerSignup", partnerSignupSchema);

const requireAdminToken = (req, res, next) => {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: "ADMIN_TOKEN not set." });
  }

  const token = req.headers["x-admin-token"] || req.query.token;
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  return next();
};

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      return res.status(500).send("Stripe webhook not configured.");
    }

    const signature = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const reservationId = session.metadata?.reservationId;

      if (reservationId) {
        const reservation = await Reservation.findByIdAndUpdate(
          reservationId,
          {
            status: "paid",
            stripeSessionId: session.id,
            stripePaymentIntentId: session.payment_intent,
          },
          { new: true }
        );

        if (reservation) {
          const itemsRows =
            buildItemsTableRows(reservation.items || []) ||
            `<tr><td style="padding:6px 0; color:#5c6b63;">Baliky</td><td style="padding:6px 0; font-weight:700; text-align:right;">-</td></tr>`;
          const itemsList = formatItemsList(reservation.items || []);
          const totalFormatted = formatEuro(reservation.totalCents);
          const logoHtml = PUBLIC_LOGO_URL
            ? `<img src="${PUBLIC_LOGO_URL}" alt="FoodSave" style="height:44px; margin-bottom:16px;" />`
            : `<h2 style="margin:0 0 8px; color:#1f2a24;">FoodSave</h2>`;

          const orderSummary = `
            <table style="width:100%; border-collapse:collapse; font-size:14px; color:#1f2a24;">
              ${itemsRows}
              <tr><td style="padding:6px 0; color:#5c6b63;">Datum</td><td style="padding:6px 0; font-weight:700; text-align:right;">${reservation.pickupDate}</td></tr>
              <tr><td style="padding:6px 0; color:#5c6b63;">Cas</td><td style="padding:6px 0; font-weight:700; text-align:right;">${reservation.pickupTime}</td></tr>
              <tr><td style="padding:6px 0; color:#5c6b63;">Spolu</td><td style="padding:6px 0; font-weight:700; text-align:right;">${totalFormatted}</td></tr>
            </table>
          `;

          if (reservation.email && resendClient && RESEND_FROM_EMAIL) {
            await resendClient.emails.send({
              from: RESEND_FROM_EMAIL,
              to: reservation.email,
              subject: "FoodSave - potvrdenie objednavky",
              html: `
                <div style="font-family:Arial, sans-serif; background:#f5faf6; padding:24px;">
                  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:18px;padding:22px 24px;box-shadow:0 10px 30px rgba(31,42,36,.12);text-align:center;">
                    ${logoHtml}
                    <h2 style="margin:6px 0 8px;color:#1f2a24;">Dakujeme za objednavku!</h2>
                    <p style="margin:0 0 12px;color:#2f3b35;font-size:15px;">
                      Vdaka tebe jedlo neskonci v kosi. Spolu setrime planetu.
                    </p>
                    <div style="background:#f7fff9;border-radius:12px;padding:14px 16px;margin:14px 0;text-align:left;">
                      ${orderSummary}
                    </div>
                    <a href="${BASE_URL}/" style="display:inline-block;background:#38b56a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:700;">
                      Spat na FoodSave
                    </a>
                    <p style="margin:16px 0 0;color:#5c6b63;font-size:13px;">
                      V pripade otazok nas kontaktujte na foodsave@gmail.com.
                    </p>
                  </div>
                </div>
              `,
            });
          }

          if (resendClient && RESEND_FROM_EMAIL && ADMIN_EMAIL) {
            const special = reservation.specialRequests
              ? `<p style="margin:12px 0 0;color:#2f3b35;"><strong>Specialne poziadavky:</strong> ${reservation.specialRequests}</p>`
              : "";
            await resendClient.emails.send({
              from: RESEND_FROM_EMAIL,
              to: ADMIN_EMAIL,
              subject: "FoodSave - nova objednavka",
              html: `
                <div style="font-family:Arial, sans-serif; background:#ffffff; padding:20px;">
                  <h2 style="margin:0 0 10px;color:#1f2a24;">Nova objednavka</h2>
                  <p style="margin:0 0 8px;color:#2f3b35;"><strong>Zakaznik:</strong> ${reservation.customerName} (${reservation.email})</p>
                  <p style="margin:0 0 8px;color:#2f3b35;"><strong>Telefon:</strong> ${reservation.phone}</p>
                  <p style="margin:0 0 8px;color:#2f3b35;"><strong>Adresa:</strong> ${reservation.address}</p>
                  <p style="margin:0 0 8px;color:#2f3b35;"><strong>Termin:</strong> ${reservation.pickupDate} ${reservation.pickupTime}</p>
                  <p style="margin:0 0 8px;color:#2f3b35;"><strong>Baliky:</strong> ${itemsList || "-"}</p>
                  <p style="margin:0 0 8px;color:#2f3b35;"><strong>Spolu:</strong> ${totalFormatted}</p>
                  ${special}
                </div>
              `,
            });
          }
        }
      }
    }


    if (event.type === "checkout.session.expired") {
      const session = event.data.object;
      const reservationId = session.metadata?.reservationId;

      if (reservationId) {
        await Reservation.findByIdAndUpdate(reservationId, {
          status: "expired",
          stripeSessionId: session.id,
        });
      }
    }

    return res.json({ received: true });
  }
);

app.disable("x-powered-by");
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/hello", (req, res) => {
  res.json({ message: "Ahoj, toto je API!" });
});

app.post("/api/checkout", async (req, res) => {
  if (!stripe) {
    return res
      .status(500)
      .json({ error: "Platobna brana nie je nastavena." });
  }

  const {
    items,
    address,
    pickupTime,
    pickupDate,
    name,
    phone,
    email,
    specialRequests,
  } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Vyber aspon jeden balik." });
  }

  if (!name || !phone || !address || !pickupTime || !pickupDate || !email) {
    return res.status(400).json({ error: "Vypln vsetky udaje." });
  }

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const minDate = new Date(today);
    const maxDate = new Date(today);
    maxDate.setDate(today.getDate() + 5);
    const selectedDate = new Date(`${pickupDate}T00:00:00`);

    if (Number.isNaN(selectedDate.getTime())) {
      return res.status(400).json({ error: "Neplatny datum." });
    }
    if (selectedDate < minDate || selectedDate > maxDate) {
      return res
        .status(400)
        .json({ error: "Datum musi byt od dnes do 5 dni." });
    }

    const normalizedItems = [];
    let totalCents = 0;
    for (const item of items) {
      const pkg = PACKAGE_CATALOG[item.packageId];
      const qty = Number(item.quantity);
      if (!pkg) {
        return res.status(400).json({ error: "Neznamy balik." });
      }
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
        return res.status(400).json({ error: "Neplatne mnozstvo." });
      }
      normalizedItems.push({
        packageId: item.packageId,
        packageName: pkg.name,
        unitPriceCents: pkg.priceCents,
        quantity: qty,
      });
      totalCents += pkg.priceCents * qty;
    }

    const reservation = await Reservation.create({
      totalCents,
      items: normalizedItems,
      address,
      pickupTime,
      pickupDate,
      customerName: name,
      phone,
      email,
      specialRequests: specialRequests ? String(specialRequests).slice(0, 500) : "",
      status: "pending",
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: normalizedItems.map((item) => ({
        price_data: {
          currency: "eur",
          product_data: { name: item.packageName },
          unit_amount: item.unitPriceCents,
        },
        quantity: item.quantity,
      })),
      success_url: `${BASE_URL}/thank-you.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/payment-failed.html`,
      metadata: { reservationId: reservation._id.toString() },
      client_reference_id: reservation._id.toString(),
    });

    reservation.stripeSessionId = session.id;
    await reservation.save();

    return res.json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: "Nepodarilo sa spustit platbu." });
  }
});

app.get("/api/checkout/session/:id", async (req, res) => {
    try {
      let reservation = await Reservation.findOne({
        stripeSessionId: req.params.id,
      }).lean();

      if (!reservation) {
        try {
          const session = await stripe.checkout.sessions.retrieve(req.params.id);
          const reservationId = session?.metadata?.reservationId;
          if (reservationId) {
            reservation = await Reservation.findById(reservationId).lean();
            if (reservation && !reservation.stripeSessionId) {
              await Reservation.findByIdAndUpdate(reservationId, {
                stripeSessionId: session.id,
              });
            }
          }
        } catch (stripeErr) {
          // ignore and fall through
        }
      }

      if (!reservation) {
        return res.status(404).json({ error: "Rezervacia nebola najdena." });
      }

      return res.json({
        items: reservation.items || [],
        totalCents: reservation.totalCents,
        status: reservation.status,
        customerName: reservation.customerName,
        pickupDate: reservation.pickupDate,
        pickupTime: reservation.pickupTime,
      });
    } catch (err) {
      return res.status(500).json({ error: "Nepodarilo sa nacitat data." });
    }
  });

app.get("/api/admin/reservations", requireAdminToken, async (req, res) => {
  try {
    const limit = Math.min(
      Number.parseInt(req.query.limit, 10) || 50,
      200
    );
    const filter = {};
    if (req.query.status) {
      filter.status = req.query.status;
    }
    const reservations = await Reservation.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return res.json({ reservations });
  } catch (err) {
    return res.status(500).json({ error: "Nepodarilo sa nacitat data." });
  }
});

app.post("/api/partners", async (req, res) => {
  const { companyName, businessType, contactName, email, city, phone } = req.body;

  if (!companyName || !businessType || !contactName || !email || !city || !phone) {
    return res.status(400).json({ error: "Vypln vsetky polia." });
  }

  try {
    const signup = await PartnerSignup.create({
      companyName,
      businessType,
      contactName,
      email,
      city,
      phone,
    });
    if (resendClient && RESEND_FROM_EMAIL && ADMIN_EMAIL) {
      await resendClient.emails.send({
        from: RESEND_FROM_EMAIL,
        to: ADMIN_EMAIL,
        subject: "FoodSave – nová registrácia partnera",
        html: `
          <div style="font-family:Arial, sans-serif; background:#ffffff; padding:20px;">
            <h2 style="margin:0 0 10px;color:#1f2a24;">Nový partner</h2>
            <p style="margin:0 0 8px;color:#2f3b35;"><strong>Firma:</strong> ${companyName}</p>
            <p style="margin:0 0 8px;color:#2f3b35;"><strong>Typ prevádzky:</strong> ${businessType}</p>
            <p style="margin:0 0 8px;color:#2f3b35;"><strong>Kontakt:</strong> ${contactName}</p>
            <p style="margin:0 0 8px;color:#2f3b35;"><strong>Email:</strong> ${email}</p>
            <p style="margin:0 0 8px;color:#2f3b35;"><strong>Mesto:</strong> ${city}</p>
            <p style="margin:0 0 8px;color:#2f3b35;"><strong>Telefón:</strong> ${phone}</p>
          </div>
        `,
      });
    }
    return res.json({ ok: true, id: signup._id });
  } catch (err) {
    return res.status(500).json({ error: "Nepodarilo sa odoslat registraciu." });
  }
});

app.get("/api/admin/partners", requireAdminToken, async (req, res) => {
  try {
    const limit = Math.min(
      Number.parseInt(req.query.limit, 10) || 100,
      500
    );
    const partners = await PartnerSignup.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return res.json({ partners });
  } catch (err) {
    return res.status(500).json({ error: "Nepodarilo sa nacitat data." });
  }
});

app.get("/api/admin/reservations.csv", requireAdminToken, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) {
      filter.status = req.query.status;
    }
    const reservations = await Reservation.find(filter)
      .sort({ createdAt: -1 })
      .limit(5000)
      .lean();

    const header = [
      "createdAt",
      "packageName",
      "quantity",
      "totalCents",
      "customerName",
      "phone",
      "address",
      "pickupTime",
      "pickupDate",
      "status",
      "stripeSessionId",
    ];

    const rows = reservations.map((r) =>
      [
        r.createdAt ? new Date(r.createdAt).toISOString() : "",
        r.packageName || "",
        r.quantity || 0,
        r.totalCents || 0,
        r.customerName || "",
        r.phone || "",
        r.address || "",
        r.pickupTime || "",
        r.pickupDate || "",
        r.status || "",
        r.stripeSessionId || "",
      ]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(",")
    );

    const csv = [header.join(","), ...rows].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=reservations.csv");
    return res.send(csv);
  } catch (err) {
    return res.status(500).send("CSV export failed.");
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

const start = async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("MongoDB pripojene");
    app.listen(PORT, () => {
      console.log(`Server bezi na http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  }
};

start();
