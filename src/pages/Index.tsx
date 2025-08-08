import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const Index = () => {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [profit, setProfit] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [wsUrl, setWsUrl] = useState<string>(() => localStorage.getItem("WS_URL") || "ws://localhost:8787");

  const wsRef = useRef<WebSocket | null>(null);
  const connected = useMemo(() => wsRef.current?.readyState === WebSocket.OPEN, [wsRef.current?.readyState]);

  useEffect(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onopen = () => pushLog("Connected to bot server.");
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string);
        if (msg.type === "log" && msg.line) pushLog(msg.line);
        if (msg.type === "status") {
          setRunning(!!msg.running);
          setStatus(msg.status || "Idle");
          setProfit(Number(msg.totalNetProfitUSD || 0));
        }
      } catch {}
    };
    ws.onclose = () => pushLog("Disconnected from bot server.");
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl]);

  function pushLog(line: string) {
    setLogs((prev) => [...prev.slice(-499), line]);
  }

  function toggle() {
    const next = !running;
    setRunning(next);
    wsRef.current?.send(JSON.stringify({ type: next ? "start" : "stop" }));
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="container py-8">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">Polygon Flash Loan Arbitrage Bot</h1>
        <p className="text-muted-foreground mt-2">Autonomous, slippage-aware execution with guaranteed-profit checks.</p>
      </header>

      <main className="container grid md:grid-cols-3 gap-6 pb-14">
        <section className="md:col-span-2 space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Control</CardTitle>
              <div className="text-sm text-muted-foreground">{connected ? "WS Connected" : "WS Disconnected"}</div>
            </CardHeader>
            <CardContent className="flex items-center gap-4">
              <Button variant="hero" size="lg" onClick={toggle}>{running ? "STOP" : "START"}</Button>
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground">Status:</span>
                <span className="px-2 py-1 rounded-md bg-secondary text-secondary-foreground text-sm">{status}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Live Log</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-80 overflow-auto rounded-md border p-3 bg-card/50 font-mono text-xs">
                {logs.map((l, i) => (
                  <div key={i} className="py-0.5">{l}</div>
                ))}
              </div>
            </CardContent>
          </Card>
        </section>

        <aside className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Total Net Profit</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-4xl font-semibold">${profit.toFixed(2)}</div>
              <p className="text-sm text-muted-foreground mt-2">Since session start</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Setup</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="text-sm text-muted-foreground">Bot WS URL</label>
              <input
                className="w-full rounded-md border bg-background px-3 py-2"
                value={wsUrl}
                onChange={(e) => setWsUrl(e.target.value)}
                onBlur={() => localStorage.setItem("WS_URL", wsUrl)}
                placeholder="ws://localhost:8787"
              />
              <p className="text-xs text-muted-foreground">
                Start the bot locally: create a .env with PRIVATE_KEY, POLYGON_RPC_URL, CONTRACT_ADDRESS then run: node bot/index.js
              </p>
            </CardContent>
          </Card>
        </aside>
      </main>
    </div>
  );
};

export default Index;
