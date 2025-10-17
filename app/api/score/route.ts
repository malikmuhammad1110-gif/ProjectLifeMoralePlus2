// app/api/score/route.ts
import { NextRequest, NextResponse } from "next/server";
import { scoreLMI } from "../../../lib/scoring";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const result = scoreLMI(body);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Invalid request" }, { status: 400 });
  }
}
