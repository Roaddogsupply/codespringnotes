---
id: 1d6b7bb4-a3d4-42d5-981a-ae966af73b32
title: "PRD: Categorization System"
projectId: a6cd2e46-a17d-493c-8a5a-277014625f20
createdAt: 2025-10-31T21:09:04.958Z
updatedAt: 2025-10-31T21:09:04.958Z
---

## Feature: Categorization System

### Overview
Allow users to create categories and attach one or more categories to their notes. Categories improve organization and enable fast filtering on the dashboard. This feature includes:
- Category management (create, update, delete)
- Assigning categories to notes
- Filtering notes by selected categories on the dashboard
- UI components for selection and display (dropdown + chips)

### User Stories & Requirements
- As an authenticated user, I want to create, rename, and delete my own categories so that I can organize notes by topic.
  - Acceptance:
    - I can add a category with a unique name (case-insensitive) within my account.
    - I cannot create duplicate category names (e.g., “Work” and “work” conflict).
    - I can update a category’s name and color.
    - I can delete a category and it is removed from all notes.
- As an authenticated user, I want to assign one or more categories to a note while creating or editing it so that I can group related notes.
  - Acceptance:
    - I can pick multiple categories from a searchable dropdown.
    - I can create a new category inline if it doesn’t exist.
    - Changes persist immediately and are reflected on the note.
- As an authenticated user, I want to filter my dashboard by category so that I can quickly find relevant notes.
  - Acceptance:
    - I can select one or more categories to filter.
    - Filter mode supports “Any” (match any selected category) and “All” (must have all).
    - The dashboard updates to show only notes matching the filter.
    - Filter state can be shared via URL query params (?categories=catId1,catId2&mode=all).
- As an authenticated user, I want category chips shown on note cards so that I can see organization at a glance.
  - Acceptance:
    - Note cards render the assigned categories as chips.
    - Each chip shows the category color and name.

### Technical Implementation

#### Database Schema
Provide only the tables required for this feature: categories and the notes-to-categories join table. The notes table is assumed to already exist.

```typescript
// /db/schema/categories.ts
import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Import your existing notes table definition
// Adjust path to your actual notes schema file
import { notes } from './note-schema';

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    name: varchar('name', { length: 64 }).notNull(),
    normalizedName: varchar('normalized_name', { length: 64 }).notNull(),
    color: varchar('color', { length: 7 }).notNull().default('#64748b'), // hex like #64748b
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      // for Drizzle, app-level $onUpdate is typical; alternatively update in code
      // .$onUpdate(() => new Date())
  },
  (t) => ({
    userIdx: index('idx_categories_user').on(t.userId),
    uniqueUserName: uniqueIndex('uq_categories_user_normalized_name').on(
      t.userId,
      t.normalizedName
    ),
  })
);

export const noteCategories = pgTable(
  'note_categories',
  {
    noteId: uuid('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ name: 'pk_note_categories', columns: [t.noteId, t.categoryId] }),
    noteIdx: index('idx_note_categories_note').on(t.noteId),
    categoryIdx: index('idx_note_categories_category').on(t.categoryId),
  })
);

// Optional helper view or materialized view not required in MVP.
```

Notes:
- normalizedName stores lowercased, trimmed version of name to enforce case-insensitive uniqueness per user.
- ON DELETE CASCADE ensures category deletion removes assignments; note deletion removes assignments.

#### API Endpoints / Server Actions
Use Next.js 14 Server Actions with Clerk for auth and Drizzle for DB. Place actions in the app’s server actions folder.

```typescript
// /actions/categories.ts
'use server';

import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { auth } from '@clerk/nextjs';
import { db } from '@/db'; // Adjust to your CodeSpring db export
import { categories, noteCategories } from '@/db/schema/categories';
import { notes } from '@/db/schema/note-schema';

const hexColor = z.string().regex(/^#([0-9A-Fa-f]{6})$/);

const createCategorySchema = z.object({
  name: z.string().min(1).max(64),
  color: hexColor.optional(),
});

const updateCategorySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(64).optional(),
  color: hexColor.optional(),
});

const assignCategoriesSchema = z.object({
  noteId: z.string().uuid(),
  categoryIds: z.array(z.string().uuid()).max(50), // prevent abuse
});

const filterNotesSchema = z.object({
  categoryIds: z.array(z.string().uuid()).min(1).max(50),
  mode: z.enum(['any', 'all']).default('any'),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

function requireUser() {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');
  return userId;
}

function normalizeName(name: string) {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export type CategoryDTO = {
  id: string;
  name: string;
  color: string;
};

export async function createCategory(input: unknown): Promise<CategoryDTO> {
  const userId = requireUser();
  const { name, color } = createCategorySchema.parse(input);
  const normalizedName = normalizeName(name);

  // Prevent duplicates
  const existing = await db.query.categories.findFirst({
    where: and(eq(categories.userId, userId), eq(categories.normalizedName, normalizedName)),
    columns: { id: true },
  });
  if (existing) throw new Error('Category name already exists');

  const [row] = await db
    .insert(categories)
    .values({
      userId,
      name: name.trim().replace(/\s+/g, ' '),
      normalizedName,
      color: color ?? '#64748b',
    })
    .returning({ id: categories.id, name: categories.name, color: categories.color });

  return row!;
}

export async function listCategories(): Promise<CategoryDTO[]> {
  const userId = requireUser();
  const rows = await db.query.categories.findMany({
    where: eq(categories.userId, userId),
    columns: { id: true, name: true, color: true },
    orderBy: (t, { asc }) => asc(t.name),
  });
  return rows;
}

export async function updateCategory(input: unknown): Promise<CategoryDTO> {
  const userId = requireUser();
  const { id, name, color } = updateCategorySchema.parse(input);

  // Ensure category belongs to user
  const cat = await db.query.categories.findFirst({
    where: and(eq(categories.id, id), eq(categories.userId, userId)),
    columns: { id: true, name: true, color: true },
  });
  if (!cat) throw new Error('Not found');

  let normalizedName: string | undefined = undefined;
  let finalName = cat.name;

  if (typeof name === 'string') {
    normalizedName = normalizeName(name);
    finalName = name.trim().replace(/\s+/g, ' ');

    const dup = await db.query.categories.findFirst({
      where: and(
        eq(categories.userId, userId),
        eq(categories.normalizedName, normalizedName),
        // not same id
        sql`${categories.id} <> ${id}`
      ),
      columns: { id: true },
    });
    if (dup) throw new Error('Category name already exists');
  }

  const [row] = await db
    .update(categories)
    .set({
      ...(name ? { name: finalName, normalizedName } : {}),
      ...(color ? { color } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(categories.id, id), eq(categories.userId, userId)))
    .returning({ id: categories.id, name: categories.name, color: categories.color });

  return row!;
}

export async function deleteCategory(id: string): Promise<{ success: true }> {
  const userId = requireUser();
  // Ensure belongs to user
  const exists = await db.query.categories.findFirst({
    where: and(eq(categories.id, id), eq(categories.userId, userId)),
    columns: { id: true },
  });
  if (!exists) throw new Error('Not found');

  // Cascades will remove assignments
  await db.delete(categories).where(and(eq(categories.id, id), eq(categories.userId, userId)));
  return { success: true };
}

export type AssignResult = { categories: CategoryDTO[] };

export async function assignCategoriesToNote(input: unknown): Promise<AssignResult> {
  const userId = requireUser();
  const { noteId, categoryIds } = assignCategoriesSchema.parse(input);

  // Normalize: unique categoryIds
  const uniqueIds = Array.from(new Set(categoryIds));

  // Validate note ownership
  const note = await db.query.notes.findFirst({
    where: and(eq(notes.id, noteId), eq(notes.userId, userId)),
    columns: { id: true },
  });
  if (!note) throw new Error('Note not found');

  // Validate categories belong to user
  if (uniqueIds.length > 0) {
    const owned = await db.query.categories.findMany({
      where: and(eq(categories.userId, userId), inArray(categories.id, uniqueIds)),
      columns: { id: true },
    });
    if (owned.length !== uniqueIds.length) throw new Error('Invalid category selection');
  }

  // Sync via transaction: make assignments exactly match uniqueIds
  await db.transaction(async (tx) => {
    // Current assignments
    const current = await tx.query.noteCategories.findMany({
      where: eq(noteCategories.noteId, noteId),
      columns: { categoryId: true },
    });
    const currentSet = new Set(current.map((c) => c.categoryId));
    const desiredSet = new Set(uniqueIds);

    const toInsert = [...desiredSet].filter((id) => !currentSet.has(id));
    const toDelete = [...currentSet].filter((id) => !desiredSet.has(id));

    if (toInsert.length) {
      await tx.insert(noteCategories).values(
        toInsert.map((cid) => ({ noteId, categoryId: cid }))
      );
    }
    if (toDelete.length) {
      await tx
        .delete(noteCategories)
        .where(
          and(eq(noteCategories.noteId, noteId), inArray(noteCategories.categoryId, toDelete))
        );
    }
  });

  // Return updated categories for the note
  const rows = await db
    .select({
      id: categories.id,
      name: categories.name,
      color: categories.color,
    })
    .from(noteCategories)
    .innerJoin(categories, eq(noteCategories.categoryId, categories.id))
    .where(and(eq(noteCategories.noteId, noteId), eq(categories.userId, userId)))
    .orderBy(categories.name);

  return { categories: rows };
}

export type FilterNotesResult = {
  noteIds: string[];
  total: number; // optional approximate for pagination, computed separately if mode='all'
};

export async function filterNotesByCategories(input: unknown): Promise<FilterNotesResult> {
  const userId = requireUser();
  const { categoryIds, mode, limit, offset } = filterNotesSchema.parse(input);

  if (mode === 'any') {
    // Notes that have at least one of the categories
    const rows = await db.execute<{ id: string }>(sql`
      select distinct n.id
      from ${notes} n
      join ${noteCategories} nc on nc.note_id = n.id
      where n.user_id = ${userId} and nc.category_id = any(${categoryIds}::uuid[])
      order by n.updated_at desc
      limit ${limit} offset ${offset}
    `);

    // For MVP, total can be approximated or omitted; here calculate quickly:
    const countRes = await db.execute<{ count: string }>(sql`
      select count(distinct n.id) as count
      from ${notes} n
      join ${noteCategories} nc on nc.note_id = n.id
      where n.user_id = ${userId} and nc.category_id = any(${categoryIds}::uuid[])
    `);

    return {
      noteIds: rows.rows.map((r) => r.id),
      total: parseInt(countRes.rows[0]?.count ?? '0', 10),
    };
  }

  // mode === 'all': Notes that have all selected categories
  const rows = await db.execute<{ id: string }>(sql`
    select n.id
    from ${notes} n
    join ${noteCategories} nc on nc.note_id = n.id
    where n.user_id = ${userId} and nc.category_id = any(${categoryIds}::uuid[])
    group by n.id
    having count(distinct nc.category_id) = ${categoryIds.length}
    order by max(n.updated_at) desc
    limit ${limit} offset ${offset}
  `);

  const countRes = await db.execute<{ count: string }>(sql`
    select count(*) as count from (
      select n.id
      from ${notes} n
      join ${noteCategories} nc on nc.note_id = n.id
      where n.user_id = ${userId} and nc.category_id = any(${categoryIds}::uuid[])
      group by n.id
      having count(distinct nc.category_id) = ${categoryIds.length}
    ) t
  `);

  return {
    noteIds: rows.rows.map((r) => r.id),
    total: parseInt(countRes.rows[0]?.count ?? '0', 10),
  };
}

export async function getCategoriesForNote(noteId: string): Promise<CategoryDTO[]> {
  const userId = requireUser();

  // Ensure note belongs to user
  const note = await db.query.notes.findFirst({
    where: and(eq(notes.id, noteId), eq(notes.userId, userId)),
    columns: { id: true },
  });
  if (!note) throw new Error('Note not found');

  const rows = await db
    .select({
      id: categories.id,
      name: categories.name,
      color: categories.color,
    })
    .from(noteCategories)
    .innerJoin(categories, eq(noteCategories.categoryId, categories.id))
    .where(and(eq(noteCategories.noteId, noteId), eq(categories.userId, userId)))
    .orderBy(categories.name);

  return rows;
}
```

#### Components Structure
```
/components/categories/
├── category-select.tsx           // Multi-select dropdown with inline create
├── category-chip.tsx             // Visual chip (badge) for a category
├── category-filter-bar.tsx       // Dashboard filter UI (chips + mode toggle)
/stores/
└── category-filter-store.ts      // Zustand store for selected filters
```

Key integrations:
- Use category-select in the note editor page: /app/notes/[id]/page.tsx (or editor component)
- Use category-filter-bar in the dashboard: /app/(dashboard)/notes/page.tsx

Example component skeletons:

```tsx
// /components/categories/category-select.tsx
'use client';

import * as React from 'react';
import { useTransition, useState } from 'react';
import { createCategory, listCategories, assignCategoriesToNote } from '@/actions/categories';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandItem, CommandEmpty } from '@/components/ui/command';
import { motion, AnimatePresence } from 'framer-motion';
import { useToast } from '@/components/ui/use-toast';

type Props = {
  noteId: string;
  selected: { id: string; name: string; color: string }[];
  onChange?: (next: Props['selected']) => void;
};

export function CategorySelect({ noteId, selected, onChange }: Props) {
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Props['selected']>([]);
  const [query, setQuery] = useState('');
  const { toast } = useToast();

  React.useEffect(() => {
    // load categories for user
    listCategories().then(setOptions).catch(() => {});
  }, []);

  const updateServer = (nextIds: string[]) => {
    startTransition(async () => {
      try {
        const res = await assignCategoriesToNote({ noteId, categoryIds: nextIds });
        onChange?.(res.categories);
      } catch (e: any) {
        toast({ variant: 'destructive', title: 'Error syncing categories', description: e.message });
      }
    });
  };

  const toggle = (id: string) => {
    const next = selected.some((c) => c.id === id)
      ? selected.filter((c) => c.id !== id)
      : [...selected, options.find((o) => o.id === id)!];

    updateServer(next.map((c) => c.id));
  };

  const onCreate = async () => {
    if (!query.trim()) return;
    try {
      const cat = await createCategory({ name: query.trim() });
      setOptions((prev) => [...prev, cat].sort((a, b) => a.name.localeCompare(b.name)));
      updateServer([...selected.map((c) => c.id), cat.id]);
      setQuery('');
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Could not create category', description: e.message });
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex_WRAP gap-2">
        <AnimatePresence>
          {selected.map((c) => (
            <motion.div key={c.id} layout initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}>
              <Badge className="cursor-pointer" style={{ backgroundColor: c.color, color: '#fff' }} onClick={() => toggle(c.id)}>
                {c.name} ✕
              </Badge>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" disabled={isPending}>Add categories</Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0">
          <Command>
            <CommandInput placeholder="Search or create..." value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandEmpty>
                <div className="p-2">
                  <Button size="sm" className="w-full" onClick={onCreate}>Create “{query}”</Button>
                </div>
              </CommandEmpty>
              {options.map((opt) => (
                <CommandItem key={opt.id} onSelect={() => toggle(opt.id)}>
                  <span className="inline-block h-3 w-3 rounded-full mr-2" style={{ backgroundColor: opt.color }} />
                  {opt.name}
                  {selected.some((c) => c.id === opt.id) && <span className="ml-auto text-muted-foreground">Selected</span>}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
```

```tsx
// /components/categories/category-chip.tsx
'use client';

import { Badge } from '@/components/ui/badge';

export function CategoryChip({ name, color }: { name: string; color: string }) {
  return (
    <Badge style={{ backgroundColor: color, color: '#fff' }}>{name}</Badge>
  );
}
```

```tsx
// /stores/category-filter-store.ts
'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Mode = 'any' | 'all';
type State = {
  selectedIds: string[];
  mode: Mode;
  setSelected: (ids: string[]) => void;
  toggle: (id: string) => void;
  setMode: (m: Mode) => void;
};

export const useCategoryFilterStore = create<State>()(
  persist(
    (set, get) => ({
      selectedIds: [],
      mode: 'any',
      setSelected: (ids) => set({ selectedIds: Array.from(new Set(ids)) }),
      toggle: (id) => {
        const s = new Set(get().selectedIds);
        s.has(id) ? s.delete(id) : s.add(id);
        set({ selectedIds: Array.from(s) });
      },
      setMode: (m) => set({ mode: m }),
    }),
    { name: 'category-filter' }
  )
);
```

```tsx
// /components/categories/category-filter-bar.tsx
'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { listCategories } from '@/actions/categories';
import { Button } from '@/components/ui/button';
import { CategoryChip } from './category-chip';
import { useCategoryFilterStore } from '@/stores/category-filter-store';

export function CategoryFilterBar() {
  const router = useRouter();
  const params = useSearchParams();
  const { selectedIds, setSelected, toggle, mode, setMode } = useCategoryFilterStore();
  const [options, setOptions] = React.useState<{ id: string; name: string; color: string }[]>([]);

  useEffect(() => {
    listCategories().then(setOptions).catch(() => {});
  }, []);

  // Sync from URL on mount
  useEffect(() => {
    const ids = params.get('categories');
    const m = params.get('mode') as 'any' | 'all' | null;
    if (ids) setSelected(ids.split(',').filter(Boolean));
    if (m) setMode(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push to URL when selection changes
  useEffect(() => {
    const qs = new URLSearchParams();
    if (selectedIds.length) qs.set('categories', selectedIds.join(','));
    if (mode !== 'any') qs.set('mode', mode);
    router.replace(`?${qs.toString()}`);
  }, [selectedIds, mode, router]);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex gap-2 flex-wrap">
        {options.map((o) => (
          <button key={o.id} onClick={() => toggle(o.id)} className={`rounded-full border px-3 py-1 text-sm ${selectedIds.includes(o.id) ? 'ring-2 ring-primary' : ''}`}>
            <span className="inline-block h-3 w-3 rounded-full mr-2" style={{ backgroundColor: o.color }} />
            {o.name}
          </button>
        ))}
      </div>
      <div className="ml-auto flex gap-2">
        <Button variant={mode === 'any' ? 'default' : 'outline'} size="sm" onClick={() => setMode('any')}>Any</Button>
        <Button variant={mode === 'all' ? 'default' : 'outline'} size="sm" onClick={() => setMode('all')}>All</Button>
      </div>
    </div>
  );
}
```

Usage in pages:
- Editor: use CategorySelect with selected categories fetched via getCategoriesForNote in a server component and passed down as props.
- Dashboard: use CategoryFilterBar and call filterNotesByCategories in the server component to fetch filtered notes.

#### State Management
- Note Editor: Local React state for selected categories; synchronize with assignCategoriesToNote server action for persistence. Optimistic updates optional.
- Dashboard Filters: Zustand store (/stores/category-filter-store.ts) to manage selected category IDs and mode. Store syncs with URL query parameters to support sharable filters and SSR of filtered notes.
- Server State: Use server actions to read/write categories. Avoid client-side mutation of persistent data.

### Dependencies & Integrations
- Auth: Clerk.dev; all actions require an authenticated user and scope data by userId.
- Database: Supabase (Postgres) with Drizzle ORM. Leverage unique index for category name per user and cascades for assignment cleanup.
- UI: ShadCN UI for Command, Popover, Badge, Button; Tailwind for styling; Framer Motion for chip animations.
- State: Zustand for dashboard filter state.
- Notes Feature Integration:
  - import notes table in schema
  - verify note ownership before assignment
  - dashboard uses filterNotesByCategories to fetch the note IDs to render
- Optional validation: zod (commonly present in CodeSpring). If not present, add zod.

No additional npm packages beyond zod (if not already included).

### Implementation Steps
1. Create database schema
   - Add /db/schema/categories.ts with categories and noteCategories.
   - Generate and run Drizzle migration against Supabase.
2. Generate queries
   - Ensure db.query.* types are available for categories and noteCategories.
3. Implement server actions
   - /actions/categories.ts with create, list, update, delete, assign, getForNote, filter functions as above.
   - Include robust auth and ownership checks.
4. Build UI components
   - /components/categories/category-select.tsx
   - /components/categories/category-chip.tsx
   - /components/categories/category-filter-bar.tsx
   - /stores/category-filter-store.ts
5. Connect frontend to backend
   - Editor page: fetch categories for note (server), pass to CategorySelect.
   - Dashboard page: read URL params, render CategoryFilterBar, call filterNotesByCategories server action to load note IDs, then fetch/render notes.
6. Add error handling
   - Use use-toast for user-facing errors.
   - Validate inputs with zod.
   - Handle duplicate category names and ownership violations gracefully.
7. Test the feature
   - Unit, integration, and UAT as defined below.
   - Verify RLS or server-side authorization is enforced via userId checks.

### Edge Cases & Error Handling
- Duplicate category names (case-insensitive) per user:
  - Prevent via normalizedName and unique index; return descriptive error.
- Excessive categories (e.g., >1k):
  - listCategories limits can be added; UI should search/filter. Consider lazy loading if needed.
- Invalid colors:
  - Validate hex format; fallback to default color.
- Assigning categories from another user or invalid IDs:
  - Validate ownership and ID existence; reject with error.
- Race conditions on rename or create:
  - Unique index ensures data integrity; catch DB errors and map to friendly messages.
- Category deletion:
  - Ensure cascading deletes remove assignments; confirm note assignments are updated in UI.
- Empty filter selection:
  - Show all notes (dashboard should handle no categoryIds by bypassing filter action).
- URL param tampering:
  - Sanitize and validate in server actions with zod; ignore invalid UUIDs.
- Long names or whitespace:
  - Trim, collapse internal whitespace; enforce max length 64.
- Unauthorized access:
  - All server actions call requireUser(); return “Unauthorized” error.

### Testing Approach
- Unit tests (Vitest/Jest)
  - normalizeName utility.
  - createCategory: prevents duplicates, trims whitespace, default color applied.
  - updateCategory: renames with uniqueness enforcement; color validation.
- Integration tests (server actions with a test DB)
  - assignCategoriesToNote:
    - Assign none, one, multiple; idempotent updates.
    - Removing categories syncs correctly.
    - Ownership checks for notes and categories.
  - deleteCategory:
    - Cascades remove assignments.
  - filterNotesByCategories:
    - mode=any returns notes with any category.
    - mode=all returns only notes that have all categories.
    - Pagination works (limit/offset).
- UI tests (Playwright/React Testing Library)
  - CategorySelect:
    - Searching and selecting existing categories.
    - Creating a new category inline and auto-assigning it.
    - Chips display and removal updates server state.
  - CategoryFilterBar:
    - Toggling categories updates URL.
    - Mode switching (Any/All) updates filter.
    - Reloading the page preserves filter from URL/Zustand.
- User acceptance tests
  - Create, rename, delete categories.
  - Assign categories to a note and see chips on the note card.
  - Filter dashboard by one or multiple categories in Any/All modes.
  - Share URL with filters and reproduce the same filtered view.

Notes:
- Security: Although the server uses service-level DB access in server actions, always scope by userId in queries. Consider adding Supabase RLS policies mirroring userId constraints for defense in depth.
- Observability: Add structured console logs or integrate your logging solution around errors in server actions for production debugging.


