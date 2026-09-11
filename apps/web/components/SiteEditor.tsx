"use client";

import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * The creator's editor for a token site: tell the agent what to change on
 * the left, see the result on the right, publish the version you like. Every
 * instruction becomes a job the bot worker runs; the page polls it and
 * shows the new version when it lands. Nothing here runs the site's HTML:
 * the preview frame is sandboxed and the document carries no scripts.
 */

type View = {
  slug: string;
  status: string;
  url: string;
  publishedN: number | null;
  token: string | null;
  launch: { name: string; ticker: string; logoUrl: string | null } | null;
  versions: Array<{ n: number; summary: string | null; prompt: string | null; createdAt: string }>;
  jobs: Array<{ id: string; status: string; instruction: string | null; versionN: number | null; error: string | null; createdAt: string }>;
  jobsToday: number;
  jobsPerDay: number;
};

type Job = { id: string; status: string; versionN: number | null; error: string | null };

const QUICK: Array<{ label: string; text: string }> = [
  { label: "Warmer colours", text: "Shift the palette to warmer tones and keep everything else." },
  { label: "Darker", text: "Make the whole site dark: dark background, light text, keep the accent." },
  { label: "Bigger hero", text: "Make the hero taller and the token name much larger." },
  { label: "Fewer images", text: "Remove decorative images and shapes; keep only the logo." },
  { label: "Shorter copy", text: "Cut every paragraph to two sentences at most." },
  { label: "Rebuild", text: "Start over with a completely different visual idea for this token." },
];

const POLL_MS = 3000;

export function SiteEditor({ slug }: { slug: string }) {
  const { ready, authenticated, login, getAccessToken } = usePrivy();
  const [view, setView] = useState<View | null | undefined>(undefined);
  const [selectedN, setSelectedN] = useState<number | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState<"desktop" | "mobile">("desktop");
  const msgsRef = useRef<HTMLDivElement>(null);

  const api = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const token = await getAccessToken();
      return fetch(`/api/site/${encodeURIComponent(slug)}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token ?? ""}`, ...(init.body ? { "content-type": "application/json" } : {}) } });
    },
    [getAccessToken, slug],
  );

  const load = useCallback(async () => {
    const res = await api("");
    if (res.status === 404 || res.status === 401) {
      setView(null);
      return null;
    }
    const v = (await res.json()) as View;
    setView(v);
    return v;
  }, [api]);

  // First load, and the version to show: the published one, else the newest.
  useEffect(() => {
    if (!ready || !authenticated) return;
    void load().then((v) => {
      if (v && selectedN === null) setSelectedN(v.publishedN ?? v.versions[0]?.n ?? null);
      const active = v?.jobs.find((j) => j.status === "QUEUED" || j.status === "RUNNING");
      if (active) setJob({ id: active.id, status: active.status, versionN: null, error: null });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated, load]);

  // Preview follows the selected version.
  useEffect(() => {
    if (selectedN === null) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    void api(`/preview?n=${selectedN}`).then(async (res) => {
      if (cancelled) return;
      setPreview(res.ok ? await res.text() : null);
    });
    return () => {
      cancelled = true;
    };
  }, [api, selectedN]);

  // Poll the running job; when it lands, show the new version.
  useEffect(() => {
    if (!job || (job.status !== "QUEUED" && job.status !== "RUNNING")) return;
    const t = setInterval(async () => {
      const res = await api(`/jobs/${job.id}`);
      if (!res.ok) return;
      const j = (await res.json()) as Job;
      setJob(j);
      if (j.status === "DONE" || j.status === "FAILED") {
        const v = await load();
        if (j.status === "DONE" && j.versionN !== null) setSelectedN(j.versionN);
        else if (v && selectedN === null) setSelectedN(v.publishedN ?? v.versions[0]?.n ?? null);
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [api, job, load, selectedN]);

  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight });
  }, [view, job]);

  const send = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t && view?.publishedN !== null) return;
      setBusy(true);
      setError(null);
      try {
        const res = await api("/jobs", { method: "POST", body: JSON.stringify({ instruction: t, baseN: selectedN }) });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error === "limit" ? `You have used today's ${view?.jobsPerDay ?? 30} changes; more tomorrow.` : body.error === "busy" ? "The agent is still working on the previous change." : `Could not queue the change (${body.error ?? res.status}).`);
          return;
        }
        const { id } = (await res.json()) as { id: string };
        setJob({ id, status: "QUEUED", versionN: null, error: null });
        setInstruction("");
        await load();
      } finally {
        setBusy(false);
      }
    },
    [api, load, selectedN, view],
  );

  const publish = useCallback(async () => {
    if (selectedN === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api("/publish", { method: "POST", body: JSON.stringify({ n: selectedN }) });
      if (!res.ok) setError("Could not publish this version.");
      await load();
    } finally {
      setBusy(false);
    }
  }, [api, load, selectedN]);

  // The conversation, oldest first: what the creator asked and what the agent answered, per version.
  const messages = useMemo(() => {
    if (!view) return [];
    const out: Array<{ key: string; role: "user" | "bot"; text: string; n?: number }> = [];
    for (const v of [...view.versions].reverse()) {
      if (v.prompt) out.push({ key: `p${v.n}`, role: "user", text: v.prompt });
      out.push({ key: `s${v.n}`, role: "bot", text: v.summary ?? (v.prompt ? "Changed." : "Built the site."), n: v.n });
    }
    for (const j of [...view.jobs].reverse()) {
      if (j.status === "FAILED") {
        if (j.instruction) out.push({ key: `jp${j.id}`, role: "user", text: j.instruction });
        out.push({ key: `je${j.id}`, role: "bot", text: `That did not work: ${j.error ?? "unknown error"}. Try again, or word it differently.` });
      }
    }
    return out;
  }, [view]);

  const working = job !== null && (job.status === "QUEUED" || job.status === "RUNNING");

  if (!ready || view === undefined) {
    if (ready && !authenticated) {
      return (
        <div className="card se-card">
          <h1 className="grad">Edit your site</h1>
          <p className="sub">Sign in with the X account that launched the token to edit its site.</p>
          <button className="btn-p" onClick={() => login()}>
            Sign in with X
          </button>
        </div>
      );
    }
    return <div className="card se-card">Loading…</div>;
  }
  if (view === null) {
    return (
      <div className="card se-card">
        <h1 className="grad">Not your site</h1>
        <p className="sub">There is no site called {slug} on your account. Sites are edited by the account that launched the token.</p>
        <Link className="btn-s" href="/me">
          Your profile
        </Link>
      </div>
    );
  }

  const name = view.launch?.name ?? view.slug;
  const ticker = view.launch?.ticker ?? view.slug.toUpperCase();
  const pill = view.status === "LIVE" ? "Live" : view.status === "GENERATING" ? "Building" : view.status === "FAILED" ? "Build failed" : "Reserved";
  const canPublish = selectedN !== null && selectedN !== view.publishedN && !working;

  return (
    <>
      <div className="se-head">
        {view.launch?.logoUrl ? <img src={view.launch.logoUrl} alt="" /> : <span className="se-logo-blank" />}
        <div>
          <h1>
            {name} <span className="se-ticker">${ticker}</span>
          </h1>
          <div className="se-sub">
            <a href={view.url} target="_blank" rel="noreferrer">
              {view.url.replace(/^https:\/\//, "")}
            </a>
            <span className={`pill ${view.status === "LIVE" ? "live" : ""}`}>{pill}</span>
          </div>
        </div>
        <div className="links">
          {view.token && (
            <Link className="btn-s" href={`/token/${view.token}`}>
              Token page
            </Link>
          )}
          <a className="btn-s" href={view.url} target="_blank" rel="noreferrer">
            Open live site
          </a>
        </div>
      </div>

      <div className="se">
        <aside className="se-chat">
          <div className="se-msgs" ref={msgsRef}>
            {messages.length === 0 && !working && (
              <div className="se-msg bot">
                {view.status === "FAILED" ? "The first build failed. Press Build to try again, or describe the site you want." : "No version yet. Press Build and the agent writes the first site from the launch."}
              </div>
            )}
            {messages.map((m) => (
              <div key={m.key} className={`se-msg ${m.role}`}>
                {m.text}
                {m.n !== undefined && (
                  <button className="n" onClick={() => setSelectedN(m.n!)} title="Show this version">
                    version {m.n}
                    {m.n === view.publishedN ? " · live" : ""}
                  </button>
                )}
              </div>
            ))}
            {working && <div className="se-msg bot working">{job?.status === "RUNNING" ? "Writing the site… about a minute." : "Queued for the agent…"}</div>}
          </div>
          <div className="se-compose">
            <div className="quick">
              {QUICK.map((q) => (
                <button key={q.label} type="button" disabled={busy || working || view.versions.length === 0} onClick={() => void send(q.text)}>
                  {q.label}
                </button>
              ))}
            </div>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(instruction);
                }
              }}
              placeholder={view.versions.length ? "Describe the change: a new tagline, another layout, a section to drop…" : "Optional: describe the site you want, then press Build."}
              maxLength={2000}
              disabled={busy || working}
            />
            <div className="row">
              <button className="btn-p" type="button" disabled={busy || working || (!instruction.trim() && view.versions.length > 0)} onClick={() => void send(instruction)}>
                {working ? "Working…" : view.versions.length ? "Change it" : "Build"}
              </button>
              <span className="hint">
                {view.jobsToday}/{view.jobsPerDay} today
              </span>
            </div>
            {error && <div className="alert">{error}</div>}
          </div>
        </aside>

        <section className="se-preview">
          <div className="se-bar">
            <label>
              Version
              <select value={selectedN ?? ""} onChange={(e) => setSelectedN(Number(e.target.value))} disabled={view.versions.length === 0}>
                {view.versions.map((v) => (
                  <option key={v.n} value={v.n}>
                    {v.n}
                    {v.n === view.publishedN ? " · live" : ""}
                    {v.prompt ? ` · ${v.prompt.slice(0, 40)}` : " · first build"}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn-p" type="button" disabled={!canPublish || busy} onClick={() => void publish()}>
              {selectedN !== null && selectedN === view.publishedN ? "Published" : "Publish this version"}
            </button>
            <span className="spacer" />
            <div className="seg" role="group" aria-label="Preview width">
              <button type="button" className={width === "desktop" ? "on" : ""} onClick={() => setWidth("desktop")}>
                Desktop
              </button>
              <button type="button" className={width === "mobile" ? "on" : ""} onClick={() => setWidth("mobile")}>
                Phone
              </button>
            </div>
          </div>
          <div className={`se-frame ${width}`}>
            {preview ? <iframe title="Site preview" srcDoc={preview} sandbox="" /> : <div className="se-empty">{selectedN === null ? "The preview appears here once the first version exists." : "Loading preview…"}</div>}
          </div>
        </section>
      </div>
    </>
  );
}
