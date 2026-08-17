"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";

export type GlobePoint = {
  lat: number;
  lng: number;
  label: string;
  age_s: number;
  visitor_id: string;
};

const ADJS  = ["Red","Blue","Fast","Cool","Dark","Wild","Calm","Bold","Keen","Warm",
                "Soft","Gray","Gold","Jade","Teal","Aqua","Rose","Lime","Sage","Dusk"];
const NOUNS = ["Fox","Owl","Elk","Cat","Jay","Bee","Emu","Yak","Koi","Ram",
               "Ibis","Lynx","Newt","Puma","Wren","Vole","Mink","Boar","Dove","Crow"];

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function visitorName(id: string): string {
  if (!id) return "Visitor";
  const h = hashCode(id);
  return ADJS[h % ADJS.length] + NOUNS[(h >> 4) % NOUNS.length];
}

function visitorColor(id: string): string {
  const h = hashCode(id || "x");
  return `hsl(${h % 360}, 65%, 55%)`;
}

function pointColor(age_s: number) {
  if (age_s < 120) return "rgba(74,222,128,0.95)";
  if (age_s < 600) return "rgba(250,204,21,0.80)";
  return "rgba(251,146,60,0.55)";
}

// Spread label position radially from the actual point.
// Each visitor gets a deterministic angle so positions are stable across polls.
const SPREAD_DEG = 14;
function labelPosition(lat: number, lng: number, visitorId: string) {
  const h = hashCode(visitorId || "x");
  const angleDeg = (h % 360);
  const rad = (angleDeg * Math.PI) / 180;
  return {
    labelLat: Math.max(-85, Math.min(85, lat + SPREAD_DEG * Math.sin(rad))),
    labelLng: lng + SPREAD_DEG * Math.cos(rad),
  };
}

function makeAvatarEl(name: string, color: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText = `
    pointer-events:none; user-select:none;
    transform: translate(-50%, -50%);
  `;
  const bubble = document.createElement("div");
  bubble.style.cssText = `
    background:${color};
    color:#fff;
    font-size:9px;
    font-weight:700;
    font-family:ui-sans-serif,system-ui,sans-serif;
    padding:2px 6px;
    border-radius:10px;
    white-space:nowrap;
    box-shadow:0 1px 5px rgba(0,0,0,.5);
    line-height:1.4;
    letter-spacing:.02em;
    max-width:80px;
    overflow:hidden;
    text-overflow:ellipsis;
  `;
  bubble.textContent = name;
  wrap.appendChild(bubble);
  return wrap;
}

const Globe = dynamic(() => import("react-globe.gl"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full w-full text-xs text-[var(--color-muted)]">
      Loading…
    </div>
  ),
});

export function VisitorGlobe({ points, isDark }: { points: GlobePoint[]; isDark: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globeRef = useRef<any>(null);
  const [size, setSize] = useState(320);
  const [spinning, setSpinning] = useState(true);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([e]) => setSize(Math.floor(e.contentRect.width)));
    ro.observe(containerRef.current);
    setSize(containerRef.current.clientWidth || 320);
    return () => ro.disconnect();
  }, []);

  const onGlobeReady = useCallback(() => {
    const ctrl = globeRef.current?.controls?.();
    if (!ctrl) return;
    ctrl.autoRotate = true;
    ctrl.autoRotateSpeed = 0.6;
    ctrl.enableZoom = false;
  }, []);

  useEffect(() => {
    const ctrl = globeRef.current?.controls?.();
    if (ctrl) ctrl.autoRotate = spinning;
  }, [spinning]);

  const toggleSpin = useCallback(() => setSpinning((s) => !s), []);

  // Build per-visitor data with spread label positions.
  const enriched = points.map((p) => {
    const { labelLat, labelLng } = labelPosition(p.lat, p.lng, p.visitor_id);
    return {
      ...p,
      name: visitorName(p.visitor_id),
      color: visitorColor(p.visitor_id),
      dotColor: pointColor(p.age_s),
      labelLat,
      labelLng,
    };
  });

  // Dot at actual location.
  const dotData = enriched.map((p) => ({
    lat: p.lat,
    lng: p.lng,
    color: p.dotColor,
  }));

  // Avatar label at offset position.
  const htmlData = enriched.map((p) => ({
    lat: p.labelLat,
    lng: p.labelLng,
    name: p.name,
    color: p.color,
  }));

  // Arc (leader line) from actual point → label position.
  const arcData = enriched.map((p) => ({
    startLat: p.lat,
    startLng: p.lng,
    endLat: p.labelLat,
    endLng: p.labelLng,
    color: p.color,
  }));

  return (
    <div
      ref={containerRef}
      onClick={toggleSpin}
      className="relative w-full flex items-center justify-center cursor-pointer select-none"
      style={{ height: size }}
      title={spinning ? "Click to pause" : "Click to resume"}
    >
      <Globe
        ref={globeRef}
        width={size}
        height={size}
        backgroundColor="rgba(0,0,0,0)"
        globeImageUrl={
          isDark
            ? "//unpkg.com/three-globe/example/img/earth-night.jpg"
            : "//unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
        }
        atmosphereColor={isDark ? "#1e40af" : "#3b82f6"}
        atmosphereAltitude={0.10}
        // Dot at exact location
        pointsData={dotData}
        pointColor={(d: object) => (d as { color: string }).color}
        pointRadius={0.4}
        pointAltitude={0.005}
        // Leader lines
        arcsData={arcData}
        arcStartLat={(d: object) => (d as { startLat: number }).startLat}
        arcStartLng={(d: object) => (d as { startLng: number }).startLng}
        arcEndLat={(d: object) => (d as { endLat: number }).endLat}
        arcEndLng={(d: object) => (d as { endLng: number }).endLng}
        arcColor={(d: object) => (d as { color: string }).color}
        arcStroke={0.4}
        arcAltitude={0.03}
        arcDashLength={1}
        arcDashGap={0}
        // Avatar labels at offset position
        htmlElementsData={htmlData}
        htmlElement={(d: object) => {
          const p = d as { name: string; color: string };
          return makeAvatarEl(p.name, p.color);
        }}
        htmlLat={(d: object) => (d as { lat: number }).lat}
        htmlLng={(d: object) => (d as { lng: number }).lng}
        htmlAltitude={0.03}
        enablePointerInteraction={false}
        animateIn={false}
        onGlobeReady={onGlobeReady}
      />
      <span className="absolute bottom-1 right-2 text-[9px] text-[var(--color-muted)] opacity-50 pointer-events-none">
        {spinning ? "⏸ pause" : "▶ resume"}
      </span>
    </div>
  );
}
