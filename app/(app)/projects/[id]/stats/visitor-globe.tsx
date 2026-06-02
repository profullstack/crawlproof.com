"use client";

import { useRef, useEffect, useState } from "react";
import dynamic from "next/dynamic";

type GlobePoint = {
  lat: number;
  lng: number;
  label: string;
  age_s: number;
};

// react-globe.gl uses WebGL/Three.js — must be client-only.
const Globe = dynamic(() => import("react-globe.gl"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-[var(--color-muted)] text-sm">
      Loading globe…
    </div>
  ),
});

function pointColor(age_s: number) {
  // Fresh (< 2 min) → bright green, older → fading yellow → dim orange
  if (age_s < 120) return "rgba(74, 222, 128, 0.95)";   // green-400
  if (age_s < 600) return "rgba(250, 204, 21, 0.80)";   // yellow-400
  return "rgba(251, 146, 60, 0.60)";                     // orange-400
}

function pointRadius(age_s: number) {
  if (age_s < 120) return 0.6;
  if (age_s < 600) return 0.45;
  return 0.3;
}

export function VisitorGlobe({
  points,
  isDark,
}: {
  points: GlobePoint[];
  isDark: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(320);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      setSize(Math.floor(entry.contentRect.width));
    });
    ro.observe(containerRef.current);
    setSize(containerRef.current.clientWidth || 320);
    return () => ro.disconnect();
  }, []);

  const globeData = points.map((p) => ({
    lat: p.lat,
    lng: p.lng,
    label: p.label,
    color: pointColor(p.age_s),
    radius: pointRadius(p.age_s),
  }));

  return (
    <div ref={containerRef} className="w-full" style={{ height: size }}>
      <Globe
        width={size}
        height={size}
        backgroundColor="rgba(0,0,0,0)"
        globeImageUrl={
          isDark
            ? "//unpkg.com/three-globe/example/img/earth-night.jpg"
            : "//unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
        }
        atmosphereColor={isDark ? "#1e40af" : "#3b82f6"}
        atmosphereAltitude={0.12}
        pointsData={globeData}
        pointColor={(d: object) => (d as { color: string }).color}
        pointRadius={(d: object) => (d as { radius: number }).radius}
        pointAltitude={0.01}
        pointLabel={(d: object) => (d as { label: string }).label}
        pointsMerge={false}
        enablePointerInteraction={true}
        animateIn={false}
      />
    </div>
  );
}
