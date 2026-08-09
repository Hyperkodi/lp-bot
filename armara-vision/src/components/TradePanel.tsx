"use client";

// Wallet-connected trading via the embedded Jupiter Terminal (Solana DEX
// aggregator). Jupiter's widget handles wallet connection (Phantom, Solflare,
// etc.), routing, and execution — nothing custodial on our side, no API key.
// EVM-only assets get a link-out until an EVM swap widget is added.
import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    Jupiter?: {
      init: (opts: Record<string, unknown>) => void;
      close?: () => void;
    };
  }
}

const JUPITER_SCRIPT = "https://terminal.jup.ag/main-v4.js";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export default function TradePanel({
  assetId,
  symbol,
  chains,
}: {
  assetId: string;
  symbol: string;
  chains: string[];
}) {
  const targetRef = useRef<HTMLDivElement>(null);
  const [mint, setMint] = useState<string | null>(null);
  const [state, setState] = useState<"resolving" | "ready" | "unavailable" | "error">("resolving");

  // Resolve the Solana mint via the market API (cached server-side).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/assets/${assetId}/market?tf=1d`);
        const data = await res.json();
        if (cancelled) return;
        if (data.solanaMint) {
          setMint(data.solanaMint);
        } else {
          setState("unavailable");
        }
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  // Load + init Jupiter Terminal once we know the mint.
  useEffect(() => {
    if (!mint) return;
    let cancelled = false;

    const init = () => {
      if (cancelled || !window.Jupiter || !targetRef.current) return;
      window.Jupiter.init({
        displayMode: "integrated",
        integratedTargetId: "jupiter-terminal-target",
        formProps: {
          initialInputMint: USDC_MINT,
          initialOutputMint: mint,
        },
        defaultExplorer: "Solscan",
      });
      setState("ready");
    };

    if (window.Jupiter) {
      init();
    } else {
      const script = document.createElement("script");
      script.src = JUPITER_SCRIPT;
      script.async = true;
      script.onload = init;
      script.onerror = () => !cancelled && setState("error");
      document.head.appendChild(script);
    }
    return () => {
      cancelled = true;
      try {
        window.Jupiter?.close?.();
      } catch {
        /* widget not mounted */
      }
    };
  }, [mint]);

  const solana = chains.includes("solana");

  return (
    <div className="border border-terminal-border bg-terminal-panel">
      <div className="flex items-center border-b border-terminal-border px-3 py-2">
        <span className="text-xs uppercase tracking-wider text-terminal-muted">Trade {symbol}</span>
        <span className="ml-auto text-[10px] text-terminal-muted">
          {state === "ready" ? "Jupiter · connect wallet in widget" : ""}
        </span>
      </div>

      {solana ? (
        <>
          <div id="jupiter-terminal-target" ref={targetRef} className="min-h-[560px] w-full" />
          {state !== "ready" && (
            <p className="px-3 pb-3 text-xs text-terminal-muted">
              {state === "resolving" && "Resolving token mint…"}
              {state === "unavailable" &&
                "Mint not resolved yet — run a snapshot or open the chart once so pool discovery can cache it."}
              {state === "error" && (
                <>
                  Trade widget unavailable (network/script blocked).{" "}
                  {mint && (
                    <a
                      href={`https://jup.ag/swap/USDC-${mint}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-terminal-amber hover:underline"
                    >
                      Open on jup.ag ↗
                    </a>
                  )}
                </>
              )}
            </p>
          )}
        </>
      ) : (
        <p className="px-3 py-4 text-xs text-terminal-muted">
          On-chain trading widget currently supports Solana-listed tokens. This asset trades on{" "}
          {chains.join(", ")} — EVM swap widget (LI.FI / Uniswap) is on the roadmap.
        </p>
      )}

      <p className="border-t border-terminal-border px-3 py-2 text-[10px] leading-relaxed text-terminal-muted">
        Execution routes through Jupiter on Solana; funds never touch this app. Tokenized equities are
        subject to issuer geographic restrictions (typically unavailable to US persons) — see the
        structure card. Nothing here is investment advice.
      </p>
    </div>
  );
}
