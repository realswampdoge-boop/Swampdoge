import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Button,
  ScrollView,
  Alert,
  Pressable,
  Linking,
  ActivityIndicator,
} from "react-native";

const MINT = "GXnNG5q32mmcpVmNAKKUf1WTSqNxoVKJyho6jQT4pump";

// ✅ OPTION 1: better public RPC than mainnet-beta
const RPC = "https://rpc.ankr.com/solana"; // try this first
// If you still get rate-limits later, you can try:
// const RPC = "https://solana-api.projectserum.com";

function isLikelySolanaAddress(addr) {
  const a = (addr || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
}
function short(s) {
  if (!s) return "";
  return s.slice(0, 4) + "…" + s.slice(-4);
}
function fmt(n, max = 6) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: max });
}

async function solanaRpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json();
  if (data?.error) throw new Error(data.error.message || "Solana RPC error");
  return data.result;
}

async function fetchSolBalance(pubkey) {
  const r = await solanaRpc("getBalance", [pubkey, { commitment: "confirmed" }]);
  return (r?.value ?? 0) / 1_000_000_000;
}

async function fetchSplTokenBalance(pubkey, mint) {
  const r = await solanaRpc("getTokenAccountsByOwner", [
    pubkey,
    { mint },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  const accts = r?.value || [];
  let total = 0;
  for (const a of accts) {
    const info = a?.account?.data?.parsed?.info;
    const ui = info?.tokenAmount?.uiAmount;
    if (typeof ui === "number") total += ui;
  }
  return total;
}

// ✅ OPTION 3: OFFLINE SAFE price fetcher with timeout + fallback
function withTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms)),
  ]);
}

async function fetchSdogePriceUsdSafe() {
  try {
    const res = await withTimeout(
      fetch(`https://api.dexscreener.com/latest/dex/tokens/${MINT}`),
      8000
    );
    const j = await res.json();
    const p = j?.pairs?.[0]?.priceUsd;
    return p ? Number(p) : null;
  } catch (e) {
    return null; // ✅ offline fallback
  }
}

async function fetchSolPriceUsdSafe() {
  try {
    const res = await withTimeout(fetch("https://price.jup.ag/v4/price?ids=SOL"), 8000);
    const j = await res.json();
    const p = j?.data?.SOL?.price;
    return typeof p === "number" ? p : null;
  } catch (e) {
    return null; // ✅ offline fallback
  }
}

async function fetchTopHolders(mint) {
  const r = await solanaRpc("getTokenLargestAccounts", [mint]);
  return r?.value || [];
}

function Sparkline({ data }) {
  const last = data.slice(-24);
  const nums = last.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (nums.length < 3) return <Text style={styles.small}>Chart warming up…</Text>;

  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = Math.max(max - min, 1e-12);

  return (
    <View style={styles.sparkRow}>
      {nums.map((v, i) => {
        const h = 6 + Math.round(((v - min) / range) * 34);
        return <View key={i} style={[styles.sparkBar, { height: h }]} />;
      })}
    </View>
  );
}

export default function App() {
  const [tab, setTab] = useState("DASH"); // DASH | CHART | HOLDERS | PICKS

  // prices
  const [sdogeUsd, setSdogeUsd] = useState(null);
  const [solUsd, setSolUsd] = useState(null);
  const [priceHistory, setPriceHistory] = useState([]);
  const [loadingPrices, setLoadingPrices] = useState(false);
  const [priceStatus, setPriceStatus] = useState("OK"); // OK | OFFLINE

  // wallet
  const [walletInput, setWalletInput] = useState("");
  const [wallet, setWallet] = useState("");
  const connected = wallet !== "";

  // balances
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [solBal, setSolBal] = useState(null);
  const [sdogeBal, setSdogeBal] = useState(null);

  // holders
  const [holders, setHolders] = useState([]);
  const [loadingHolders, setLoadingHolders] = useState(false);

  // picks
  const [name, setName] = useState("");
  const [picksWallet, setPicksWallet] = useState("");
  const [pick1, setPick1] = useState("");
  const [pick2, setPick2] = useState("");
  const [pick3, setPick3] = useState("");
  const [pick4, setPick4] = useState("");

  const [lastUpdated, setLastUpdated] = useState(null);

  // ✅ cooldowns to reduce spam / rate-limits
  const lastPriceTap = useRef(0);
  const lastHoldersTap = useRef(0);
  const COOLDOWN_MS = 8000;

  const portfolioUsd = useMemo(() => {
    if (solUsd === null || solBal === null) return null;
    const solVal = solBal * solUsd;
    const tokVal = sdogeUsd === null || sdogeBal === null ? 0 : sdogeBal * sdogeUsd;
    return solVal + tokVal;
  }, [solUsd, solBal, sdogeUsd, sdogeBal]);

  const stamp = () => setLastUpdated(new Date().toLocaleTimeString());

  const refreshPrices = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastPriceTap.current < COOLDOWN_MS) {
      Alert.alert("Slow down", "Give it a few seconds, then refresh again.");
      return;
    }
    lastPriceTap.current = now;

    try {
      setLoadingPrices(true);

      // offline-safe: returns null instead of throwing
      const [p1, p2] = await Promise.all([fetchSdogePriceUsdSafe(), fetchSolPriceUsdSafe()]);

      // if both null => offline
      if (p1 === null && p2 === null) {
        setPriceStatus("OFFLINE");
      } else {
        setPriceStatus("OK");
      }

      if (p1 !== null) {
        setSdogeUsd(p1);
        setPriceHistory((prev) => {
          const next = [...prev, p1];
          return next.length > 60 ? next.slice(-60) : next;
        });
      }

      if (p2 !== null) setSolUsd(p2);

      stamp();
    } finally {
      setLoadingPrices(false);
    }
  };

  const refreshBalances = async () => {
    if (!wallet) return;
    try {
      setLoadingBalances(true);
      const [s, t] = await Promise.all([fetchSolBalance(wallet), fetchSplTokenBalance(wallet, MINT)]);
      setSolBal(s);
      setSdogeBal(t);
      stamp();
    } catch (e) {
      Alert.alert("Balance error", String(e?.message || e));
    } finally {
      setLoadingBalances(false);
    }
  };

  const refreshHolders = async () => {
    const now = Date.now();
    if (now - lastHoldersTap.current < COOLDOWN_MS) {
      Alert.alert("Slow down", "Try again in a few seconds.");
      return;
    }
    lastHoldersTap.current = now;

    try {
      setLoadingHolders(true);
      const top = await fetchTopHolders(MINT);
      setHolders(top.slice(0, 15));
      stamp();
    } catch (e) {
      Alert.alert("Holders error", String(e?.message || e));
    } finally {
      setLoadingHolders(false);
    }
  };

  const refreshAll = async () => {
    await Promise.all([refreshPrices(true), connected ? refreshBalances() : Promise.resolve()]);
  };

  const connectWallet = () => {
    const a = walletInput.trim();
    if (!isLikelySolanaAddress(a)) {
      Alert.alert("Invalid wallet", "Paste a valid Solana wallet address.");
      return;
    }
    setWallet(a);
  };

  const disconnect = () => {
    setWallet("");
    setWalletInput("");
    setSolBal(null);
    setSdogeBal(null);
  };

  // auto refresh every 60s (safe)
  useEffect(() => {
    refreshPrices(true);
    const t = setInterval(() => {
      refreshPrices(true);
      if (connected) refreshBalances();
    }, 60000);
    return () => clearInterval(t);
  }, [connected, wallet]);

  useEffect(() => {
    if (wallet) refreshBalances();
  }, [wallet]);

  const openDex = () => Linking.openURL(`https://dexscreener.com/solana/${MINT}`);
  const openPump = () => Linking.openURL(`https://pump.fun/coin/${MINT}`);
  const openJup = () => Linking.openURL(`https://jup.ag/swap/SOL-${MINT}`);
  const openSolscan = (addr) => Linking.openURL(`https://solscan.io/account/${addr}`);

  const submitPicks = () => {
    if (!name.trim()) return Alert.alert("Missing name", "Enter your name.");
    if (!isLikelySolanaAddress(picksWallet.trim()))
      return Alert.alert("Wallet needed", "Paste a valid Solana wallet for prize payout.");

    Alert.alert(
      "Picks submitted",
      `Name: ${name}\nWallet: ${picksWallet}\n\n1) ${pick1 || "—"}\n2) ${pick2 || "—"}\n3) ${pick3 || "—"}\n4) ${pick4 || "—"}`
    );
  };

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>🐊 SwampDoge</Text>
      <Text style={styles.subtitle}>Solana Super App</Text>

      <View style={styles.tabs}>
        {["DASH", "CHART", "HOLDERS", "PICKS"].map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.tabBtn, tab === t && styles.tabBtnOn]}>
            <Text style={[styles.tabText, tab === t && styles.tabTextOn]}>{t}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.small}>Last updated: {lastUpdated || "—"}</Text>

      {tab === "DASH" && (
        <>
          <View style={styles.card}>
            <Text style={styles.h}>Portfolio Value</Text>
            <Text style={styles.big}>{portfolioUsd === null ? "—" : `$${fmt(portfolioUsd, 2)}`}</Text>
            <Button title={loadingPrices || loadingBalances ? "Loading..." : "Refresh Everything"} onPress={refreshAll} />
            {priceStatus === "OFFLINE" && (
              <Text style={styles.warn}>Prices offline in Snack right now — try again later.</Text>
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.h}>Prices</Text>
            <Text style={styles.line}>SDOGE: {sdogeUsd === null ? "—" : `$${fmt(sdogeUsd, 10)}`}</Text>
            <Text style={styles.line}>SOL: {solUsd === null ? "—" : `$${fmt(solUsd, 4)}`}</Text>
            <Button title="Refresh Prices" onPress={refreshPrices} />
            {priceStatus === "OFFLINE" && (
              <Text style={styles.warn}>If this stays offline, it’s Snack blocking requests.</Text>
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.h}>Trade / Chart</Text>
            <Button title="Open Dexscreener" onPress={openDex} />
            <View style={{ height: 8 }} />
            <Button title="Buy / Sell (Pump.fun)" onPress={openPump} />
            <View style={{ height: 8 }} />
            <Button title="Swap (Jupiter)" onPress={openJup} />
          </View>

          <View style={styles.card}>
            <Text style={styles.h}>Wallet</Text>
            {!connected ? (
              <>
                <TextInput
                  placeholder="Paste Solana wallet address"
                  placeholderTextColor="#888"
                  style={styles.input}
                  value={walletInput}
                  onChangeText={setWalletInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Button title="Connect Wallet" onPress={connectWallet} />
                <Text style={styles.small}>Not connected</Text>
              </>
            ) : (
              <>
                <Text style={styles.small}>Connected:</Text>
                <Text style={styles.wallet}>{wallet}</Text>

                <Text style={styles.line}>SOL: {solBal === null ? "—" : `${fmt(solBal, 6)} SOL`}</Text>
                <Text style={styles.line}>SDOGE: {sdogeBal === null ? "—" : `${fmt(sdogeBal, 6)} SDOGE`}</Text>

                <View style={{ height: 8 }} />
                <Button title="Refresh Balances" onPress={refreshBalances} />
                <View style={{ height: 8 }} />
                <Button title="Disconnect" onPress={disconnect} />
              </>
            )}
          </View>
        </>
      )}

      {tab === "CHART" && (
        <View style={styles.card}>
          <Text style={styles.h}>In-App Live Chart</Text>
          <Text style={styles.small}>Builds from price samples (updates every minute).</Text>
          {priceStatus === "OFFLINE" && (
            <Text style={styles.warn}>Chart paused (Snack network blocked). Try later.</Text>
          )}
          <View style={{ height: 10 }} />
          <Sparkline data={priceHistory} />
          <View style={{ height: 10 }} />
          <Button title={loadingPrices ? "Loading..." : "Refresh Price Sample"} onPress={refreshPrices} />
          <View style={{ height: 8 }} />
          <Button title="Open Full Chart (Dexscreener)" onPress={openDex} />
        </View>
      )}

      {tab === "HOLDERS" && (
        <View style={styles.card}>
          <Text style={styles.h}>Top Holders</Text>
          <Text style={styles.small}>On-chain via RPC. Cooldown prevents spam.</Text>
          <View style={{ height: 10 }} />
          <Button title={loadingHolders ? "Loading..." : "Load Holders"} onPress={refreshHolders} />
          <View style={{ height: 10 }} />

          {loadingHolders ? (
            <ActivityIndicator />
          ) : holders.length === 0 ? (
            <Text style={styles.small}>Tap “Load Holders”.</Text>
          ) : (
            holders.map((h, idx) => (
              <Pressable key={h.address} onPress={() => openSolscan(h.address)} style={styles.holderRow}>
                <Text style={styles.holderLeft}>
                  #{idx + 1} {short(h.address)}
                </Text>
                <Text style={styles.holderRight}>{h.uiAmountString || "—"}</Text>
              </Pressable>
            ))
          )}

          <Text style={styles.small}>Tap a holder to open Solscan.</Text>
        </View>
      )}

      {tab === "PICKS" && (
        <View style={styles.card}>
          <Text style={styles.h}>SwampDoge Picks</Text>
          <Text style={styles.small}>UI ready — next we wire auto games + payouts.</Text>

          <Text style={styles.label}>Name</Text>
          <TextInput style={styles.input} placeholder="Your name" placeholderTextColor="#888" value={name} onChangeText={setName} />

          <Text style={styles.label}>Solana Wallet (prize)</Text>
          <TextInput
            style={styles.input}
            placeholder="Paste your Solana wallet"
            placeholderTextColor="#888"
            value={picksWallet}
            onChangeText={setPicksWallet}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>Pick 1</Text>
          <TextInput style={styles.input} placeholder="Example: Lakers" placeholderTextColor="#888" value={pick1} onChangeText={setPick1} />
          <Text style={styles.label}>Pick 2</Text>
          <TextInput style={styles.input} placeholder="Example: Duke" placeholderTextColor="#888" value={pick2} onChangeText={setPick2} />
          <Text style={styles.label}>Pick 3</Text>
          <TextInput style={styles.input} placeholder="Example: Over 47.5" placeholderTextColor="#888" value={pick3} onChangeText={setPick3} />
          <Text style={styles.label}>Pick 4</Text>
          <TextInput style={styles.input} placeholder="Example: Arsenal" placeholderTextColor="#888" value={pick4} onChangeText={setPick4} />

          <View style={{ height: 10 }} />
          <Button title="Submit Picks" onPress={submitPicks} />
        </View>
      )}

      <Text style={styles.footer}>Install: Share → Add to Home Screen</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0d1117", padding: 20 },
  title: { color: "#00ff88", fontSize: 34, fontWeight: "bold", textAlign: "center" },
  subtitle: { color: "white", textAlign: "center", marginBottom: 12 },

  tabs: { flexDirection: "row", justifyContent: "space-between", marginBottom: 10 },
  tabBtn: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#111827", borderWidth: 1, borderColor: "#223" },
  tabBtnOn: { borderColor: "#00ff88" },
  tabText: { color: "#aab", fontWeight: "bold", fontSize: 12 },
  tabTextOn: { color: "#00ff88" },

  card: { backgroundColor: "#0f172a", padding: 15, borderRadius: 12, marginBottom: 15, borderWidth: 1, borderColor: "#1f2a44" },
  h: { color: "white", marginBottom: 10, fontWeight: "bold", fontSize: 16 },

  big: { color: "#00ff88", fontSize: 28, fontWeight: "bold", marginBottom: 10 },
  line: { color: "#cbd5e1", marginBottom: 6 },
  small: { color: "#94a3b8", marginBottom: 8 },
  label: { color: "#cbd5e1", marginTop: 10, marginBottom: 6 },

  warn: { color: "#fbbf24", marginTop: 10 },

  input: { backgroundColor: "#111827", color: "white", padding: 10, borderRadius: 8, borderWidth: 1, borderColo: "#223" },
  wallet: { color: "white", fontSize: 12, marginBottom: 10 },

  sparkRow: { flexDirection: "row", alignItems: "flex-end", gap: 2, height: 46, paddingVertical: 6 },
  sparkBar: { width: 6, backgroundColor: "#00ff88", borderRadius: 3, opacity: 0.85 },

  holderRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#182238" },
  holderLeft: { color: "white", fontWeight: "bold" },
  holderRight: { color: "#00ff88", fontWeight: "bold" },

  footer: { color: "#556", textAlign: "center", marginTop: 10, marginBottom: 20 },
})