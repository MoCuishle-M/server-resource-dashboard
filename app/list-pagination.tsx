"use client";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const sizes = [10, 20, 50, 100, 0] as const;

export function useListPagination<T>(items: T[], storageKey: string, resetKey: string, defaultSize = 20) {
  const [pageSize, setPageSize] = useState(defaultSize);
  const [position, setPosition] = useState({ key: resetKey, page: 1 });
  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null && sizes.some(size => size === Number(stored))) setPageSize(Number(stored));
    } catch { /* Keep pagination available when storage is disabled. */ }
  }, [storageKey]);
  const pageCount = pageSize === 0 ? 1 : Math.max(1, Math.ceil(items.length / pageSize));
  const page = position.key === resetKey ? Math.min(position.page, pageCount) : 1;
  const start = pageSize === 0 ? 0 : (page - 1) * pageSize;
  const rows = pageSize === 0 ? items : items.slice(start, start + pageSize);
  function changeSize(size: number) {
    if (!sizes.some(value => value === size)) return;
    setPageSize(size);
    setPosition({ key: resetKey, page: 1 });
    try { localStorage.setItem(storageKey, String(size)); } catch { /* The current view still works. */ }
  }
  return {
    rows, pageSize, page, pageCount, total: items.length,
    first: items.length ? start + 1 : 0, last: start + rows.length,
    changeSize,
    changePage: (next: number) => setPosition({ key: resetKey, page: Math.max(1, Math.min(next, pageCount)) }),
  };
}

type Pagination = Omit<ReturnType<typeof useListPagination>, "rows">;

export default function ListPagination({ pagination: p, label, bottom = false }: {
  pagination: Pagination; label: string; bottom?: boolean;
}) {
  return <nav className={`list-pagination${bottom ? " list-pagination-bottom" : ""}`} aria-label={`${label}${bottom ? "底部" : ""}分页`}>
    {!bottom && <label className="page-size-label">每页显示
      <select aria-label={`${label}每页条数`} value={p.pageSize} onChange={e => p.changeSize(Number(e.target.value))}>
        {sizes.map(size => <option key={size} value={size}>{size === 0 ? "全部" : `${size} 条`}</option>)}
      </select>
    </label>}
    <span className="pagination-count" role="status">共 {p.total} 条 · 显示 {p.first}–{p.last} 条</span>
    <div className="pagination-buttons">
      <button className="button" aria-label={`${label}上一页`} disabled={p.page <= 1} onClick={() => p.changePage(p.page - 1)}><ChevronLeft size={15} />上一页</button>
      <span>{p.page} / {p.pageCount} 页</span>
      <button className="button" aria-label={`${label}下一页`} disabled={p.page >= p.pageCount} onClick={() => p.changePage(p.page + 1)}>下一页<ChevronRight size={15} /></button>
    </div>
  </nav>;
}
