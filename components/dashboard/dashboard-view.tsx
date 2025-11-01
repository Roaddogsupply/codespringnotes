"use client";

import DashboardHeader from "./dashboard-header";
import NotesList from "./notes-list";
import type { Category, NoteListItem } from "@/lib/mock-data";
import { useMemo, useState } from "react";

export default function DashboardView({
  initialNotes,
  categories,
}: {
  initialNotes: NoteListItem[];
  categories: Category[];
}) {
  const [notes, setNotes] = useState<NoteListItem[]>(initialNotes);
  const [q, setQ] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);

  const resetPage = () => setPage(1);

  const { paged, meta } = useMemo(() => {
    const normalizedQ = q.trim().toLowerCase();
    const filtered = (notes || [])
      .filter((n) => (categoryId ? n.categoryId === categoryId : true))
      .filter((n) =>
        normalizedQ
          ? (n.title || "").toLowerCase().includes(normalizedQ) || (n.preview || "").toLowerCase().includes(normalizedQ)
          : true
      );

    const end = page * pageSize;
    const slice = filtered.slice(0, end);

    return {
      paged: slice,
      meta: {
        page,
        pageSize,
        total: filtered.length,
        hasMore: end < filtered.length,
      },
    };
  }, [notes, q, categoryId, page, pageSize]);

  const handleAddNote = () => {
    const newNote: NoteListItem = {
      id: `note-${Date.now()}`,
      title: "Untitled",
      preview: "",
      updatedAt: new Date().toISOString(),
      categoryId: null,
      categoryName: null,
      categoryColor: null,
    };
    setNotes((prev) => [newNote, ...prev]);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <DashboardHeader
        categories={categories}
        onAddNote={handleAddNote}
        q={q}
        categoryId={categoryId}
        setQ={setQ}
        setCategoryId={setCategoryId}
        resetPage={resetPage}
      />
      <NotesList
        data={paged}
        meta={meta}
        loading={false}
        error={undefined}
        onLoadMore={() => setPage((p) => p + 1)}
      />
    </div>
  );
}
