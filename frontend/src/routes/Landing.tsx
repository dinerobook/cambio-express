import { useState } from "react";

import { usePublicPricing } from "../api/billing";
import { BrandLink } from "../components/BrandLink";
import { fmtMoney } from "../lib/formatters";
import { PRODUCT_FEATURES } from "../lib/productFeatures";
import { Link } from "react-router-dom";

import styles from "./Landing.module.css";

// Marketing page, at /features. The site root opens on sign-in
// (Home → Login, with a features panel beside the form); this is
// the full tour that panel links to.
//
// Positioning (2026-09): the people we are talking to run a
// convenience store or gas station, very often with a money-service
// counter, and today they either pay an incumbent back-office suite
// per store or keep paper. Three things set DineroBook apart and
// the page leads with them in this order:
//
//   1. The register feeds the books. We read the Gilbarco Passport
//      journal files the store already produces — every ticket,
//      every tender, every department — so closing the day starts
//      from data, not from a paper Z-report.
//   2. The money-service counter is part of the same product:
//      transfers, senders, ACH reconciliation, returned checks, the
//      rate board on the TV. Incumbent c-store suites don't do this;
//      MSB tools don't do the store.
//   3. Price. One flat price per store, from the plan catalog, no
//      contract.
//
// Every claim below is something the product does today. No invented
// customers, stats or quotes — a landing page that fibs costs the
// trust it was meant to build.
export default function Landing() {
  const [navOpen, setNavOpen] = useState(false);
  // Prices come from the server (PLAN_CATALOG), never a copy here —
  // the copy that used to live in this file drifted from checkout.
  const pricing = usePublicPricing();
  const plans = pricing.data?.plans ?? [];
  const basic = plans.find((p) => p.key === "basic");
  const pro = plans.find((p) => p.key === "pro");
  const fromPrice = basic ? fmtMoney(basic.monthly_cents / 100) : null;

  return (
    <div className={styles.shell}>
      <nav className={styles.nav}>
        <BrandLink />
        <button
          type="button"
          className={styles.navToggle}
          aria-label="Toggle menu"
          aria-expanded={navOpen}
          onClick={() => setNavOpen((v) => !v)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div
          className={`${styles.navLinks}${navOpen ? ` ${styles.open}` : ""}`}
          onClick={(e) => {
            if ((e.target as HTMLElement).tagName === "A") setNavOpen(false);
          }}
        >
          <a href="#product">Product</a>
          <a href="#switch">Switching</a>
          <a href="#pricing">Pricing</a>
          <Link to="/login">Sign in</Link>
          <Link to="/signup" className={styles.navCta}>Start free trial</Link>
        </div>
      </nav>

      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className={styles.hero}>
        <div className={styles.heroGlow} aria-hidden="true" />
        <div className={styles.heroInner}>
          <div className={styles.eyebrow}>
            <span className={styles.eyebrowDot} />
            C-STORES · GAS STATIONS · MONEY SERVICES
          </div>
          <h1 className={styles.heroTitle}>
            Your register already knows what sold today.{" "}
            <span className={styles.accent}>Now your books do too.</span>
          </h1>
          <p className={styles.heroSub}>
            DineroBook reads the journal files your Gilbarco register already
            writes, books the day, counts the lottery, logs every wire and
            check at the money-service counter, and rolls it all into a
            monthly P&amp;L. One login for the whole store.
          </p>
          <div className={styles.ctas}>
            <Link to="/signup" className={styles.btnPrimary}>Start free trial</Link>
            <a href="#product" className={styles.btnGhost}>See what it does</a>
          </div>
          <div className={styles.heroTrust}>
            7-day free trial · no card · no contract
            {fromPrice ? ` · from ${fromPrice} per store` : ""}
          </div>
        </div>
      </section>

      {/* ── Three reasons ────────────────────────────────────── */}
      <section className={styles.section}>
        <div className={styles.sectionEye}>WHY STORES SWITCH</div>
        <h2 className={styles.sectionTitle}>
          Three things the other back offices{" "}
          <span className={styles.accent}>don't do.</span>
        </h2>
        <div className={styles.reasons}>
          <div className={styles.reason}>
            <div className={styles.reasonNum}>01</div>
            <div className={styles.reasonTitle}>The register feeds the books.</div>
            <div className={styles.reasonBody}>
              Drop in the day's Gilbarco Passport journal and DineroBook fills
              the daily book from it: sales by department, every tender,
              every ticket down to the line item, voids and cancels included.
              You reconcile against real data instead of re-typing a Z-report.
            </div>
          </div>
          <div className={styles.reason}>
            <div className={styles.reasonNum}>02</div>
            <div className={styles.reasonTitle}>The money counter is built in.</div>
            <div className={styles.reasonBody}>
              Transfers, senders, returned checks, ACH batches and the rate
              board on your TV live in the same product as the store books.
              A store that sends money doesn't need two systems and two bills.
            </div>
          </div>
          <div className={styles.reason}>
            <div className={styles.reasonNum}>03</div>
            <div className={styles.reasonTitle}>One flat price. No contract.</div>
            <div className={styles.reasonBody}>
              {fromPrice ? `From ${fromPrice} a month per store` : "One monthly price per store"},
              unlimited employees and transactions, cancel any time, and your
              data stays for 180 days after. No setup fee, no hardware, no
              sales call.
            </div>
          </div>
        </div>
      </section>

      {/* ── Product tour ─────────────────────────────────────── */}
      <section className={styles.section} id="product">
        <div className={styles.sectionEye}>THE PRODUCT</div>
        <h2 className={styles.sectionTitle}>
          Every part of the day, <span className={styles.accent}>one login.</span>
        </h2>
        <p className={styles.sectionLead}>
          Turn on the modules your store uses. A gas station without a money
          counter never sees the transfer screens; a check-cashing storefront
          never sees the fuel ones.
        </p>

        <div className={styles.features}>
          {PRODUCT_FEATURES.map((f) => (
            <div key={f.eye} className={styles.feature}>
              <div className={styles.featureEye}>{f.eye}</div>
              <div className={styles.featureTitle}>{f.title}</div>
              <ul className={styles.featureList}>
                {f.points.map((pt) => <li key={pt}>{pt}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* ── Switching ────────────────────────────────────────── */}
      <section className={styles.section} id="switch">
        <div className={styles.sectionEye}>SWITCHING</div>
        <h2 className={styles.sectionTitle}>
          Coming from Modisoft or Cronysoft?{" "}
          <span className={styles.accent}>Bring what you already have.</span>
        </h2>
        <div className={styles.switchGrid}>
          <div className={styles.switchCard}>
            <div className={styles.switchTitle}>Your register files</div>
            <div className={styles.switchBody}>
              The same Gilbarco Passport journals your current system reads.
              Nothing to reconfigure at the pump or the till.
            </div>
          </div>
          <div className={styles.switchCard}>
            <div className={styles.switchTitle}>Your price book</div>
            <div className={styles.switchBody}>
              Import items and departments from a NAXML price-book export,
              then keep it current from vendor invoices.
            </div>
          </div>
          <div className={styles.switchCard}>
            <div className={styles.switchTitle}>Your team</div>
            <div className={styles.switchBody}>
              Add cashiers and managers with the access their job needs.
              Unlimited people on every plan.
            </div>
          </div>
          <div className={styles.switchCard}>
            <div className={styles.switchTitle}>Your money counter</div>
            <div className={styles.switchBody}>
              If you send transfers or cash checks, that side of the business
              comes along too — in the same product, on the same bill.
            </div>
          </div>
        </div>
      </section>

      {/* ── Pricing ──────────────────────────────────────────── */}
      <section className={styles.section} id="pricing">
        <div className={styles.sectionEye}>PRICING</div>
        <h2 className={styles.sectionTitle}>
          One price per store. <span className={styles.accent}>No surprises.</span>
        </h2>
        <div className={styles.pricing}>
          <div className={styles.plan}>
            <div className={styles.planName}>BASIC</div>
            <div className={styles.planPrice}>
              {basic ? fmtMoney(basic.monthly_cents / 100) : "—"}
              <span className={styles.priceSuffix}>/mo</span>
            </div>
            <div className={styles.planPeriod}>
              per store · or {basic ? fmtMoney(basic.yearly_cents / 100) : "—"} a year
              {basic && basic.months_free > 0
                ? ` (${basic.months_free} months free)`
                : ""}
            </div>
            <ul className={styles.planFeats}>
              <li><span className={styles.ck}>✓</span>Store daily book with register import</li>
              <li><span className={styles.ck}>✓</span>Transactions, lottery, price book, purchases</li>
              <li><span className={styles.ck}>✓</span>Money transfers, ACH and returned checks</li>
              <li><span className={styles.ck}>✓</span>Monthly P&amp;L and reports, CSV export</li>
              <li><span className={styles.ck}>✓</span>Time clock, schedule and access roles</li>
              <li><span className={styles.ck}>✓</span>Unlimited employees and transactions</li>
            </ul>
            <Link to="/signup?plan=basic" className={`${styles.planBtn} ${styles.planBtnOutline}`}>
              Start with Basic
            </Link>
          </div>
          <div className={styles.plan}>
            <div className={styles.planName}>PRO</div>
            <div className={styles.planPrice}>
              {pro ? fmtMoney(pro.monthly_cents / 100) : "—"}
              <span className={styles.priceSuffix}>/mo</span>
            </div>
            <div className={styles.planPeriod}>
              per store · or {pro ? fmtMoney(pro.yearly_cents / 100) : "—"} a year
              {pro && pro.months_free > 0
                ? ` (${pro.months_free} months free)`
                : ""}
            </div>
            <ul className={styles.planFeats}>
              <li><span className={styles.ck}>✓</span>Everything in Basic</li>
              <li><span className={styles.ck}>✓</span>Live bank sync and auto-categorised charges</li>
              <li><span className={styles.ck}>✓</span>Multi-store owner view and cross-store rollups</li>
              <li><span className={styles.ck}>✓</span>Rate board for the TV in your store</li>
              <li><span className={styles.ck}>✓</span>Priority support</li>
            </ul>
            <Link to="/signup?plan=pro" className={`${styles.planBtn} ${styles.planBtnNeon}`}>
              Start with Pro
            </Link>
          </div>
        </div>
        <div className={styles.pricingFine}>
          7-day free trial on either plan, no card to start. Cancel any time;
          your books stay readable for 180 days after.
        </div>
      </section>

      {/* ── FAQ ──────────────────────────────────────────────── */}
      <section className={styles.section}>
        <div className={styles.sectionEye}>QUESTIONS</div>
        <div className={styles.faq}>
          <div className={styles.faqItem}>
            <div className={styles.faqQ}>Do I need new hardware?</div>
            <div className={styles.faqA}>
              No. DineroBook reads the journal files a Gilbarco Passport
              register already produces. If you don't have one, the daily book
              still works — you enter the day's numbers by hand.
            </div>
          </div>
          <div className={styles.faqItem}>
            <div className={styles.faqQ}>Can my cashiers use it?</div>
            <div className={styles.faqA}>
              Yes. Every plan includes unlimited employees. Each person gets a
              sign-in with only the screens their job needs, and everything
              they change is logged with their name on it.
            </div>
          </div>
          <div className={styles.faqItem}>
            <div className={styles.faqQ}>I only run a money-service counter. Is this for me?</div>
            <div className={styles.faqA}>
              Yes. Turn off the retail modules and you get the transfer ledger,
              the MSB daily book, ACH reconciliation, returned checks and the
              monthly P&amp;L on their own.
            </div>
          </div>
          <div className={styles.faqItem}>
            <div className={styles.faqQ}>What happens to my data if I leave?</div>
            <div className={styles.faqA}>
              It stays readable and exportable for 180 days after you cancel,
              then it's deleted. You can download your books as CSV at any
              time before that.
            </div>
          </div>
        </div>
      </section>

      <section className={styles.closing}>
        <h2 className={styles.closingTitle}>
          Close tonight's day <span className={styles.accent}>from the register.</span>
        </h2>
        <Link to="/signup" className={styles.btnPrimary}>Start free trial</Link>
      </section>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <BrandLink />
          <div className={styles.footerCopy}>© 2026 DineroBook · Back office for stores that move money.</div>
          <div className={styles.footerLinks}>
            <Link to="/privacy">Privacy</Link>
            <Link to="/login">Sign in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

