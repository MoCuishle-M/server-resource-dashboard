"use client";
import { useEffect, useState } from "react";
const sizes = [100, 115, 130, 150];
const key = "resource-dashboard-font-size";
export default function FontSizeControl() {
  const [size, setSize] = useState(130);
  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem(key));
      if (sizes.includes(stored)) setSize(stored);
    } catch { /* Browser storage may be disabled. */ }
  }, []);
  useEffect(() => {
    document.documentElement.style.setProperty("--font-scale", String(size / 100));
  }, [size]);
  return <label className="font-size-control"><span>网页字号</span><select aria-label="网页字号" value={size} onChange={e => {
    const next = Number(e.target.value);
    setSize(next);
    try { localStorage.setItem(key, String(next)); } catch { /* Keep the setting for this page. */ }
  }}>
    <option value={100}>标准 100%</option><option value={115}>较大 115%</option>
    <option value={130}>大 130%</option><option value={150}>特大 150%</option>
  </select></label>;
}
