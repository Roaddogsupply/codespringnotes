---
id: 826acea2-4d2c-46ed-9293-39f33bfeaf5c
title: "PRD: Dashboard View"
projectId: a6cd2e46-a17d-493c-8a5a-277014625f20
createdAt: 2025-10-31T21:04:47.882Z
updatedAt: 2025-10-31T21:04:47.882Z
---

## Feature: Dashboard View

### Status Update (2025-11-01)
- Implemented a UI-only prototype using mocked data. No database, server actions, or API routes have been created yet.
- Deviations from original plan (temporary for prototype):
  - Uses local React state in `DashboardView` instead of Zustand + SWR.
  - Uses `lib/mock-data.ts` for categories and notes instead of DB.
  - No server action `getNotesForDashboard` and no `/api/notes` or `/api/categories` routes.
  - Added a "New note" button in the header that prepends a mock note in local state.
  - Path used is `app/dashboard/page.tsx` (no `(app)` segment).

### Overview
The Dashboard View lists a user's notes in a clean, searchable, and filterable interface. It shows note title, a short preview, category tag, and last updated date. Users can search notes and filter by category, and click a note to open it for reading/editing. The view is optimized for fast initial load (SSR) and responsive interactions (client-side filtering with SWR).

### User Stories & Requirements
- As an authenticated user, I want to see my most recent notes on the dashboard so that I can quickly access what I worked on last.
  - Acceptance Criteria:
    - On page load, notes are sorted by updatedAt desc.
    - Each note card shows title, category (if any), preview text, and updated time.
    - Only notes belonging to the current user are visible.

- As a user, I want to search notes by title or content so that I can find specific notes quickly.
  - Acceptance Criteria:
    - A search input filters notes by title and content (case-insensitive).
    - Results update within 300ms after typing (debounced).
    - If no results, show an empty state message with guidance.

- As a user, I want to filter notes by category so that I can narrow down the list to relevant items.
  - Acceptance Criteria:
    - A category filter lists the user’s categories.
    - Selecting a category shows only notes in that category.
    - A “All” option clears the filter.

- As a user, I want pagination or infinite load to handle large note lists.
  - Acceptance Criteria:
    - The dashboard loads in pages of 20 items by default.
    - A “Load more” button or infinite scroll fetches the next page.
    - Performance remains responsive with large datasets.

- As a user, I want to click a note to open it for viewing/editing.
  - Acceptance Criteria:
    - Clicking a note navigates to /notes/[id].
    - Navigation is client-side and fast.

### Technical Implementation

#### Prototype (UI-only) Approach
- Data: `lib/mock-data.ts` exports `mockCategories` and `mockNotes`.
- State: Local React state inside `components/dashboard/dashboard-view.tsx` for `notes`, `q`, `categoryId`, `page`, `pageSize`.
- Search: Debounced (300ms) client-side filter by `title` and `preview` on the mock data.
- Filter: Category dropdown uses mock categories passed via props.
- Pagination: Client-side "Load more" increments page and slices the filtered list.
- New Note: Header includes a "New note" button that prepends an Untitled note in memory.
- Navigation: `note-card` links to `/notes/[id]` (route not yet implemented in prototype).

These choices are temporary and intended to validate the UI flows quickly. The original server-side and data plan below remains the target for integration.

#### Planned Server/Data Model (unchanged, not yet implemented)
Only schema required for the dashboard (notes and categories). Assumes Clerk userId is a string stored in userId columns.

```typescript
// /db/schema/notes.ts
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(), // Clerk user id
    name: text('name').notNull(),
    color: text('color'), // optional hex or tailwind token
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userNameUnique: uniqueIndex('categories_user_name_unique').on(t.userId, t.name),
    userIdx: index('categories_user_idx').on(t.userId),
  }),
);

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(), // Clerk user id
    title: text('title').notNull().default(''),
    // TipTap JSON content stored as JSONB
    content: jsonb('content').notNull().default({}),
    // Plain text content used for preview and simple search
    contentText: text('content_text').notNull().default(''),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    userUpdatedIdx: index('notes_user_updated_idx').on(t.userId, t.updatedAt),
    categoryIdx: index('notes_category_idx').on(t.categoryId),
    userIdIdx: index('notes_user_idx').on(t.userId),
  }),
);

export const notesRelations = relations(notes, ({ one }) => ({
  category: one(categories, {
    fields: [notes.categoryId],
    references: [categories.id],
  }),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  notes: many(notes),
}));
```

Notes:
- contentText should be kept in sync when saving notes (outside this feature).
- Optional: add a full-text search index in a later migration for scalability.

#### API Endpoints / Server Actions

Server action for initial SSR fetch (uses CodeSpring pattern for server actions) and a route handler for client-side SWR.

```typescript
// /actions/notes-list.ts
'use server';

import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { notes, categories } from '@/db/schema/notes';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';

export type ListNotesInput = {
  q?: string;
  categoryId?: string | null;
  page?: number;
  pageSize?: number;
};

export async function getNotesForDashboard(input: ListNotesInput = {}) {
  const { userId } = auth();
  if (!userId) {
    throw new Error('Unauthorized');
  }

  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(50, Math.max(1, input.pageSize ?? 20));
  const offset = (page - 1) * pageSize;
  const q = input.q?.trim();

  const conditions = [
    eq(notes.userId, userId),
    isNull(notes.deletedAt),
    input.categoryId ? eq(notes.categoryId, input.categoryId) : undefined,
    q ? or(ilike(notes.title, `%${q}%`), ilike(notes.contentText, `%${q}%`)) : undefined,
  ].filter(Boolean) as any[];

  const where = conditions.length ? and(...conditions) : undefined;

  const data = await db
    .select({
      id: notes.id,
      title: notes.title,
      contentText: notes.contentText,
      updatedAt: notes.updatedAt,
      categoryId: notes.categoryId,
      categoryName: categories.name,
      categoryColor: categories.color,
    })
    .from(notes)
    .leftJoin(categories, eq(notes.categoryId, categories.id))
    .where(where)
    .orderBy(desc(notes.updatedAt))
    .limit(pageSize)
    .offset(offset);

  const [{ count }] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(notes)
    .where(where);

  return {
    data: data.map((n) => ({
      ...n,
      preview: n.contentText.slice(0, 160),
    })),
    meta: {
      page,
      pageSize,
      total: Number(count),
      hasMore: page * pageSize < Number(count),
    },
  };
}
```

```typescript
// /app/api/notes/route.ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getNotesForDashboard } from '@/actions/notes-list';

const QuerySchema = z.object({
  q: z.string().trim().optional(),
  categoryId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
});

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const parsed = QuerySchema.safeParse(Object.fromEntries(searchParams));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid query params' }, { status: 400 });
    }
    const data = await getNotesForDashboard(parsed.data);
    return NextResponse.json(data, { status: 200 });
  } catch (err: any) {
    const message = process.env.NODE_ENV === 'development' ? err?.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: err?.message === 'Unauthorized' ? 401 : 500 });
  }
}
```

#### Components Structure

```
/app/dashboard/page.tsx                 // Dashboard page (renders UI-only prototype)
/components/dashboard/dashboard-view.tsx // Client shell with SWR + state
/components/dashboard/dashboard-header.tsx
/components/dashboard/category-filter.tsx
/components/dashboard/notes-list.tsx
/components/dashboard/note-card.tsx
/components/dashboard/empty-state.tsx
/components/dashboard/skeletons.tsx
/stores/dashboard-store.ts               // Zustand store (planned, not used in prototype)
/lib/format.ts                            // date/time utils
```

- page.tsx: Server component, fetches initial data with server action for fast first paint.
- dashboard-view.tsx: Client component. In prototype, holds local React state for search/filter/pagination and passes props to children. In planned version, will move to Zustand + SWR.
- dashboard-header.tsx: Search input (debounced) + category filter + New note button (prototype only; will hook to real create later).
- category-filter.tsx: ShadCN Command/Select listing categories.
- notes-list.tsx: Renders list with motion transitions and "Load more".
- note-card.tsx: Displays title, preview, category badge, updated time; clickable.
- empty-state.tsx: Shown when no results or no notes.
- skeletons.tsx: Loading placeholders.

Example key components (updated for prototype):

```typescript
// /app/dashboard/page.tsx (prototype)
import DashboardView from "@/components/dashboard/dashboard-view";
import { mockCategories, mockNotes } from "@/lib/mock-data";

export default function DashboardPage() {
  return (
    <main className="p-6 md:p-10">
      <h1 className="mb-6 text-3xl font-bold">Dashboard</h1>
      <DashboardView initialNotes={mockNotes} categories={mockCategories} />
    </main>
  );
}
```

```typescript
// /components/dashboard/dashboard-view.tsx (prototype)
'use client';

import DashboardHeader from './dashboard-header';
import NotesList from './notes-list';
import type { Category, NoteListItem } from '@/lib/mock-data';
import { useMemo, useState } from 'react';

export default function DashboardView({ initialNotes, categories }: { initialNotes: NoteListItem[]; categories: Category[] }) {
  const [notes, setNotes] = useState<NoteListItem[]>(initialNotes);
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);

  const resetPage = () => setPage(1);

  const { paged, meta } = useMemo(() => {
    const normalizedQ = q.trim().toLowerCase();
    const filtered = (notes || [])
      .filter((n) => (categoryId ? n.categoryId === categoryId : true))
      .filter((n) => (normalizedQ ? (n.title || '').toLowerCase().includes(normalizedQ) || (n.preview || '').toLowerCase().includes(normalizedQ) : true));

    const end = page * pageSize;
    const slice = filtered.slice(0, end);

    return { paged: slice, meta: { page, pageSize, total: filtered.length, hasMore: end < filtered.length } };
  }, [notes, q, categoryId, page, pageSize]);

  const handleAddNote = () => {
    const newNote: NoteListItem = { id: `note-${Date.now()}`, title: 'Untitled', preview: '', updatedAt: new Date().toISOString(), categoryId: null, categoryName: null, categoryColor: null };
    setNotes((prev) => [newNote, ...prev]);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <DashboardHeader categories={categories} q={q} categoryId={categoryId} setQ={setQ} setCategoryId={setCategoryId} resetPage={() => setPage(1)} onAddNote={handleAddNote} />
      <NotesList data={paged} meta={meta} loading={false} error={undefined} onLoadMore={() => setPage((p) => p + 1)} />
    </div>
  );
}
```

```typescript
// /components/dashboard/dashboard-header.tsx (prototype)
'use client';

import { Input } from '@/components/ui/input';
import CategoryFilter from './category-filter';
import type { Category } from '@/lib/mock-data';
import { useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';

export default function DashboardHeader({ categories, q, categoryId, setQ, setCategoryId, resetPage, onAddNote }: { categories: Category[]; q: string; categoryId: string | null; setQ: (q: string) => void; setCategoryId: (id: string | null) => void; resetPage: () => void; onAddNote: () => void; }) {
  const onSearch = useMemo(
    () =>
      debounce((val: string) => {
        setQ(val);
        resetPage();
      }, 300),
    [setQ, resetPage],
  );

  const handleCategory = useCallback(
    (id?: string | null) => {
      setCategoryId(id ?? null);
      resetPage();
    },
    [setCategoryId, resetPage],
  );

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center">
      <Input placeholder="Search notes..." defaultValue={q} onChange={(e) => onSearch(e.target.value)} className="md:w-80" />
      <CategoryFilter categories={categories} value={categoryId} onChange={handleCategory} />
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
```

```typescript
// /components/dashboard/category-filter.tsx
'use client';

import { useEffect, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Category = { id: string; name: string };

export default function CategoryFilter({
  value,
  onChange,
}: { value: string | null; onChange: (id?: string | null) => void }) {
  const [categories, setCategories] = useState<Category[]>([]);

  useEffect(() => {
    // lightweight fetch of categories (could be SSR too)
    fetch('/api/categories')
      .then((r) => r.json())
      .then((d) => setCategories(d?.data ?? []))
      .catch(() => setCategories([]));
  }, []);

  return (
    <Select value={value ?? 'all'} onValueChange={(v) => onChange(v === 'all' ? null : v)}>
      <SelectTrigger className="w-[220px]">
        <SelectValue placeholder="Filter by category" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All categories</SelectItem>
        {categories.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

```typescript
// /components/dashboard/notes-list.tsx
'use client';

import { motion, AnimatePresence } from 'framer-motion';
import NoteCard from './note-card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import Skeletons from './skeletons';

export default function NotesList({
  data,
  meta,
  loading,
  error,
  onLoadMore,
}: {
  data: any[];
  meta: { page: number; pageSize: number; total: number; hasMore: boolean } | undefined;
  loading: boolean;
  error: any;
  onLoadMore: () => void;
}) {
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Failed to load notes. Please try again.</AlertDescription>
      </Alert>
    );
  }

  if (loading && (!data || data.length === 0)) {
    return <Skeletons count={8} />;
  }

  if (!data || data.length === 0) {
    return <div className="text-center text-muted-foreground">No notes found.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        <AnimatePresence>
          {data.map((n) => (
            <motion.div
              key={n.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
            >
              <NoteCard note={n} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {meta?.hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
```

```typescript
// /components/dashboard/note-card.tsx
'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';

export default function NoteCard({
  note,
}: {
  note: {
    id: string;
    title: string;
    preview: string;
    updatedAt: string;
    categoryName?: string | null;
    categoryColor?: string | null;
  };
}) {
  return (
    <Link href={`/notes/${note.id}`} className="block">
      <Card className="hover_BORDER-primary/50 transition-colors">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="truncate">{note.title || 'Untitled'}</CardTitle>
            {note.categoryName ? (
              <Badge
                className={cn('text-xs', note.categoryColor ? '' : 'bg-secondary')}
                style={note.categoryColor ? { backgroundColor: note.categoryColor } : undefined}
              >
                {note.categoryName}
              </Badge>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p className="line-clamp-3">{note.preview}</p>
          <p className="mt-3 text-xs">
            Updated {formatDistanceToNow(new Date(note.updatedAt), { addSuffix: true })}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}
```

```typescript
// /components/dashboard/skeletons.tsx
'use client';

export default function Skeletons({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="animate-pulse rounded-lg border p-4">
          <div className="mb-3 h-4 w-1/2 rounded bg-muted" />
          <div className="mb-2 h-3 w-full rounded bg-muted" />
          <div className="mb-2 h-3 w-5/6 rounded bg-muted" />
          <div className="h-3 w-2/3 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
```

```typescript
// /stores/dashboard-store.ts
import { create } from 'zustand';

type State = {
  q: string;
  categoryId: string | null;
  page: number;
  pageSize: number;
};

type Actions = {
  setQ: (q: string) => void;
  setCategoryId: (id: string | null) => void;
  resetPage: () => void;
};

export const useDashboardStore = create<State & Actions>((set) => ({
  q: '',
  categoryId: null,
  page: 1,
  pageSize: 20,
  setQ: (q) => set({ q }),
  setCategoryId: (id) => set({ categoryId: id }),
  resetPage: () => set({ page: 1 }),
}));
```

Minimal categories API for filter (read-only):

```typescript
// /app/api/categories/route.ts
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { categories } from '@/db/schema/notes';
import { eq } from 'drizzle-orm';

export async function GET() {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const data = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(eq(categories.userId, userId));

  return NextResponse.json({ data }, { status: 200 });
}
```

#### State Management
- Prototype: Local React state in `dashboard-view.tsx` for `notes`, `q`, `categoryId`, `page`, `pageSize`.
- Planned: SSR initial data via server action `getNotesForDashboard` for fast load, Zustand store for client state, and SWR for revalidation.
- URL Sync: Deferred for prototype; planned for later using query params.

### Dependencies & Integrations
- Integrations:
  - Clerk: Authenticate requests in server actions and route handlers using @clerk/nextjs/server.
  - Supabase + Drizzle: Query notes/categories scoped by userId.
  - ShadCN UI: Input, Select, Card, Badge, Button, Alert components.
  - Framer Motion: AnimatePresence and motion for list/card animations.
  - TipTap: Not directly edited here, but contentText is used for previews and search (populated on note save elsewhere).
- Prototype uses existing deps only (no new installs). SWR and zod are deferred to integration phase.

### Implementation Steps
1. Prototype (done)
   - Build UI-only components in `/components/dashboard/*` with ShadCN + Framer Motion.
   - Add `lib/mock-data.ts` and render via `/app/dashboard/page.tsx`.
   - Implement search/filter/pagination locally and a temporary "New note" button.

2. Integrate (next)
   - Add `/db/schema/notes.ts` and run migrations.
   - Create server action `getNotesForDashboard` and `/api/notes`, `/api/categories`.
   - Switch to Zustand store + SWR and add URL sync.
   - Add zod validation and proper error handling.

### Edge Cases & Error Handling
- Unauthenticated access
  - API returns 401; page redirects to sign-in using Clerk.
- Invalid categoryId UUID
  - API returns 400 from zod validation.
- Large datasets
  - Pagination enforced; pageSize capped at 50.
- No notes or no search results
  - Show friendly empty state message.
- Deleted notes
  - Filtered out via deletedAt is null.
- Missing category
  - Note card renders without badge gracefully.
- Very long titles or content
  - Truncate with CSS line-clamp and server-generated preview.
- Network failures
  - SWR exposes error; UI shows Alert with retry via refocus.
- XSS concerns
  - Do not render raw HTML; use contentText (plain text) for preview.

### Testing Approach
- Unit tests
  - Preview generation logic ensuring correct slice length and no HTML injection.
  - Zod query schema: valid/invalid inputs.
  - Zustand store actions (setQ, setCategoryId, resetPage).
- Integration tests (planned)
  - `/api/notes` and `/api/categories` behave as specified once implemented.
  - SSR page renders initial notes with mocked Clerk.
- User acceptance tests
  - On login, dashboard shows most recent notes first.
  - Typing a search updates the list within ~300ms and is case-insensitive.
  - Selecting a category filters results; clearing shows all.
  - Load more fetches additional pages and appends to the list.
  - Clicking a note navigates to /notes/[id].

Notes for Production Readiness:
- Consider adding a tsvector column and GIN index for scalable full-text search in a future iteration.
- Instrument logging around API errors and add request tracing if available.
- Add rate-limiting to /api/notes to protect from abuse if exposing publicly.


