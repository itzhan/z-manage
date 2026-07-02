import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const a = auth(req);
  if (!a.ok) return a.error!;

  const { count, hubUrl } = (await req.json()) as { count: number; hubUrl: string };
  if (!count || !hubUrl) {
    return Response.json({ error: "缺少 count 或 hubUrl" }, { status: 400 });
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT email, session_key FROM registered_accounts
       WHERE (exported = 0 OR exported IS NULL)
         AND session_key IS NOT NULL AND session_key != ''
       ORDER BY uploadedAt DESC LIMIT ?`
    )
    .all(count) as { email: string; session_key: string }[];

  if (!rows.length) {
    return Response.json({ error: "没有可导出的 key" }, { status: 400 });
  }

  const keys = rows.map((r) => r.session_key);
  const target = hubUrl.replace(/\/+$/, "") + "/api/keys";

  try {
    const resp = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    });
    const data = await resp.json();

    if (!resp.ok || !data.success) {
      return Response.json({ error: data.error || "中枢返回错误" }, { status: 502 });
    }

    const emails = rows.map((r) => r.email);
    const placeholders = emails.map(() => "?").join(",");
    db.prepare(
      `UPDATE registered_accounts SET exported = 1, exportedAt = ? WHERE email IN (${placeholders})`
    ).run(new Date().toISOString(), ...emails);

    return Response.json({
      success: true,
      exported: rows.length,
      hubAdded: data.data.added,
      hubTotal: data.data.total,
    });
  } catch (e: unknown) {
    return Response.json(
      { error: `连接中枢失败: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }
}
