"use client";

import { Input } from "@/components/ui/input";
import CategoryFilter from "./category-filter";
import type { Category } from "@/lib/mock-data";
import { useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";

export default function DashboardHeader({
  categories,
  q,
  categoryId,
  setQ,
  setCategoryId,
  resetPage,
  onAddNote,
  onChanged,
}: {
  categories: Category[];
  q: string;
  categoryId: string | null;
  setQ: (q: string) => void;
  setCategoryId: (id: string | null) => void;
  resetPage: () => void;
  onAddNote: () => void;
  onChanged?: () => void;
}) {
  const onSearch = useMemo(
    () =>
      debounce((val: string) => {
        setQ(val);
        resetPage();
        onChanged?.();
      }, 300),
    [setQ, resetPage, onChanged]
  );

  const handleCategory = useCallback(
    (id?: string | null) => {
      setCategoryId(id ?? null);
      resetPage();
      onChanged?.();
    },
    [setCategoryId, resetPage, onChanged]
  );

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center">
      <Input
        placeholder="Search notes..."
        defaultValue={q}
        onChange={(e) => onSearch(e.target.value)}
        className="md:w-80"
      />
      <CategoryFilter
        categories={categories}
        value={categoryId}
        onChange={handleCategory}
      />
      <div className="md:ml-auto">
        <Button onClick={onAddNote}>New note</Button>
      </div>
    </div>
  );
}

function debounce<T extends (...args: any[]) => void>(fn: T, wait = 300) {
  let t: any;
  return (...args: Parameters<T>) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
