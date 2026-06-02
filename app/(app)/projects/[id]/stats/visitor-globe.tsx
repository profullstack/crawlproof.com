"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";

export type GlobePoint = {
  lat: number;
  lng: number;
  label: string;      // city/country
  age_s: number;
  visitor_id: string;
};

// Adjective + animal pairs from a stable seed — gives memorable anonymous names.
const ADJS = ["Red","Blue","Fast","Cool","Dark","Wild","Calm","Bold","Keen","Warm",
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

// Consistent pastel hue from visitor_id.
function visitorColor(id: string): string {
  const h = hashCode(id || "x");
  return `hsl(${h % 360}, 65%, 55%)`;
}

function pointColor(age_s: number) {
  if (age_s < 120) return "rgba(74,222,128,0.95)";
  if (age_s < 600) return "rgba(250,204,21,0.80)";
  return "rgba(251,146,60,0.55)";
}

function makeAvatarEl(name: string, color: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText = `
    display:flex; flex-direction:column; align-items:center;
    pointer-events:none; user-select:none;
    transform: translate(-50%, -120%);
  `;

  const bubble = document.createElement("div");
  bubble.style.cssText = `
    background:${color};
    color:#fff;
    font-size:9px;
    font-weight:700;
    font-family:ui-sans-serif,system-ui,sans-serif;
    padding:2px 5px;
    border-radius:10px;
    white-space:nowrap;
    box-shadow:0 1px 4px rgba(0,0,0,.45);
    line-height:1.4;
    letter-spacing:.02em;
    max-width:72px;
    overflow:hidden;
    text-overflow:ellipsis;
  `;
  bubble.textContent = name;

  const pin = document.createElement("div");
  pin.style.cssText = `
    width:0; height:0;
    border-left:3px solid transparent;
    border-right:3px solid transparent;
    border-top:5px solid ${color};
    margin-top:-1px;
  `;

  wrap.appendChild(bubble);
  wrap.appendChild(pin);
  return wrap;
}

// react-globe.gl is WebGL/Three.js — client-only.
const Globe = dynamic(() => import("react-globe.gl"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full w-full text-xs text-[var(--color-muted)]">
      Loading…
    </div>
  ),
});

export function VisitorGlobe({
  points,
  isDark,
}: {
  points: GlobePoint[];
  isDark: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globeRef = useRef<any>(null);
  const [size, setSize] = useState(200);
  const [spinning, setSpinning] = useState(true);

  // Measure container — globe is capped at 280px.
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([e]) => {
      setSize(Math.min(280, Math.floor(e.contentRect.width)));
    });
    ro.observe(containerRef.current);
    setSize(Math.min(280, containerRef.current.clientWidth || 200));
    return () => ro.disconnect();
  }, []);

  // Wire up auto-rotate once the globe is ready.
  const onGlobeReady = useCallback(() => {
    const ctrl = globeRef.current?.controls?.();
    if (!ctrl) return;
    ctrl.autoRotate = true;
    ctrl.autoRotateSpeed = 0.6;
    ctrl.enableZoom = false;
  }, []);

  // Sync spinning state to controls whenever it changes.
  useEffect(() => {
    const ctrl = globeRef.current?.controls?.();
    if (ctrl) ctrl.autoRotate = spinning;
  }, [spinning]);

  const toggleSpin = useCallback(() => setSpinning((s) => !s), []);

  // Build HTML avatar elements (memoised by visitor_id list).
  const htmlData = points.map((p) => ({
    lat: p.lat,
    lng: p.lng,
    name: visitorName(p.visitor_id),
    color: visitorColor(p.visitor_id),
    visitor_id: p.visitor_id,
  }));

  const dotData = points.map((p) => ({
    lat: p.lat,
    lng: p.lng,
    color: pointColor(p.age_s),
  }));

  return (
    <div
      ref={containerRef}
      onClick={toggleSpin}
      className="relative flex items-center justify-center cursor-pointer select-none"
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
        // Dot per visitor (faint glow under the avatar)
        pointsData={dotData}
        pointColor={(d: object) => (d as { color: string }).color}
        pointRadius={0.3}
        pointAltitude={0.005}
        // HTML avatar labels
        htmlElementsData={htmlData}
        htmlElement={(d: object) => {
          const p = d as { name: string; color: string };
          return makeAvatarEl(p.name, p.color);
        }}
        htmlLat={(d: object) => (d as { lat: number }).lat}
        htmlLng={(d: object) => (d as { lng: number }).lng}
        htmlAltitude={0.02}
        enablePointerInteraction={false}
        animateIn={false}
        onGlobeReady={onGlobeReady}
      />
      {/* Pause/play badge */}
      <span className="absolute bottom-1 right-1 text-[9px] text-[var(--color-muted)] opacity-60 pointer-events-none">
        {spinning ? "⏸ click to pause" : "▶ click to resume"}
      </span>
    </div>
  );
}
