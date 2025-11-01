---
id: 78094e1a-7dbc-45a6-8cad-9d9abe224ce8
title: "PRD: Database Integration"
projectId: a6cd2e46-a17d-493c-8a5a-277014625f20
createdAt: 2025-10-31T21:10:37.084Z
updatedAt: 2025-10-31T21:10:37.084Z
---

## Feature: Database Integration

### Overview
Persist and manage notes and categories in Supabase Postgres using Drizzle ORM and Next.js 14 Server Actions. This feature provides secure, multi-tenant CRUD for notes and categories scoped to the authenticated Clerk user, with production-ready error handling and cache revalidation.

### User Stories & Requirements
- As an authenticated user, I want to save a new note so that I can access it later from any device.
  - Acceptance:
    - Note is created with title, optional rich content (TipTap JSON), and optional category.
    - Note is scoped to the current user.
    - UI updates without a full page reload.
    - Validation errors displayed for invalid input (e.g., excessively long title).

- As an authenticated user, I want to list my notes (optionally filtered by category) so that I can quickly find my content.
  - Acceptance:
    - Only the user’s notes are returned.
    - Supports optional filters: categoryId, includeArchived, search (simple title/plaintext match).
    - Supports pagination via limit and cursor.
    - Fast response (<300ms p50 in typical conditions) with proper indexing.

- As an authenticated user, I want to update a note so that I can revise content.
  - Acceptance:
    - Partial updates supported (title, content, category, isArchived).
    - Concurrency-safe: if the note has changed since I fetched it, return a conflict error.
    - Returns the updated note.

- As an authenticated user, I want to delete a note so that I can remove content I no longer need.
  - Acceptance:
    - Only notes belonging to the user can be deleted.
    - Deleting returns success and revalidates the notes list cache.

- As an authenticated user, I want to manage categories so that I can organize my notes.
  - Acceptance:
    - Create category (name unique per user).
    - Rename category.
    - Delete category: associated notes have categoryId set to null.

Non-functional requirements:
- Secure by default, scoped by Clerk userId on every query/mutation.
- Proper logging of failures without leaking sensitive data.
- All mutations use Next.js Server Actions.
- DB access only on the server; no secrets exposed to the client.
- Drizzle used for schema/migrations and runtime queries.

### Technical Implementation

#### Database Schema
Provide the Drizzle ORM schema ONLY for tables needed by this feature.

```typescript
// /db/schema/notes.ts
import { pgTable, uuid, text, boolean, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(), // Clerk userId
    name: text('name').notNull(),
    color: text('color'), // optional hex or token
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUserIdx: index('idx_categories_user').on(t.userId),
    uniqueNamePerUser: uniqueIndex('uq_categories_user_name').on(t.userId, t.name),
  })
);

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(), // Clerk userId
    title: text('title').notNull().default(''),
    content: jsonb('content').notNull().default({}), // TipTap JSON
    plainText: text('plain_text'), // for simple search/snippets
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    isArchived: boolean('is_archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUserIdx: index('idx_notes_user').on(t.userId),
    byUserUpdatedIdx: index('idx_notes_user_updated').on(t.userId, t.updatedAt),
    byUserCategoryIdx: index('idx_notes_user_category').on(t.userId, t.categoryId),
  })
);

// Optional relations (if using drizzle relations in queries)
export const categoriesRelations = relations(categories, ({ many }) => ({
  notes: many(notes),
}));

export const notesRelations = relations(notes, ({ one }) => ({
  category: one(categories, {
    fields: [notes.categoryId],
    references: [categories.id],
  }),
}));
```

```typescript
// /db/index.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/notes';

// Use a singleton to avoid exhausting connections in dev
const globalForDb = global as unknown as { conn?: ReturnType<typeof postgres> };

const connection = globalForDb.conn ?? postgres(process.env.DATABASE_URL!, {
  ssl: 'require',
  max: 3, // conservative for serverless
  idle_timeout: 20,
  connect_timeout: 10,
});
if (process.env.NODE_ENV !== 'production') globalForDb.conn = connection;

export const db = drizzle(connection, { schema });

export type Db = typeof db;
```

Notes:
- DATABASE_URL must be the Supabase Postgres connection string (with SSL).
- We scope all queries by userId at the application layer. Ensure every where clause includes userId.

#### API Endpoints / Server Actions
All mutations are implemented as Server Actions; data fetching is done in Server Components or Server Actions. Inputs validated with Zod; access controlled via Clerk.

```typescript
// /lib/validation/notes.ts
import { z } from 'zod';

export const noteContentSchema = z.record(z.any()).refine((v) => typeof v === 'object', 'Invalid content');

export const createNoteSchema = z.object({
  title: z.string().trim().max(256),
  content: noteContentSchema.optional(),
  plainText: z.string().max(10000).optional(),
  categoryId: z.string().uuid().optional().nullable(),
});

export const updateNoteSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().max(256).optional(),
  content: noteContentSchema.optional(),
  plainText: z.string().max(10000).optional(),
  categoryId: z.string().uuid().nullable().optional(),
  isArchived: z.boolean().optional(),
  // optimistic concurrency
  ifUpdatedAt: z.string().datetime().optional(),
});

export const listNotesSchema = z.object({
  categoryId: z.string().uuid().optional(),
  includeArchived: z.boolean().optional(),
  search: z.string().trim().max(256).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(), // simple cursor by id
});

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(64),
  color: z.string().regex(/^#?[0-9a-fA-F]{3,8}$/).optional(),
});

export const updateCategorySchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(64).optional(),
  color: z.string().regex(/^#?[0-9a-fA-F]{3,8}$/).optional(),
});
```

```typescript
// /lib/auth.ts
import { auth } from '@clerk/nextjs/server';

export function requireUserId() {
  const { userId } = auth();
  if (!userId) {
    throw new Error('UNAUTHORIZED');
  }
  return userId;
}
```

```typescript
// /actions/notes.ts
'use server';

import { db } from '@/db';
import { notes, categories } from '@/db/schema/notes';
import { and, eq, asc, desc, ilike, sql, gt } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireUserId } from '@/lib/auth';
import { createNoteSchema, updateNoteSchema, listNotesSchema } from '@/lib/validation/notes';

export async function createNote(input: unknown) {
  const userId = requireUserId();
  const data = createNoteSchema.parse(input);

  if (data.categoryId) {
    const cat = await db.query.categories.findFirst({
      where: and(eq(categories.id, data.categoryId), eq(categories.userId, userId)),
      columns: { id: true },
    });
    if (!cat) {
      throw new Error('CATEGORY_NOT_FOUND');
    }
  }

  const now = new Date();
  const [row] = await db
    .insert(notes)
    .values({
      userId,
      title: data.title ?? '',
      content: (data.content as any) ?? {},
      plainText: data.plainText,
      categoryId: data.categoryId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  revalidatePath('/notes');
  return row;
}

export async function listNotes(input: unknown) {
  const userId = requireUserId();
  const args = listNotesSchema.parse(input ?? {});
  const where = and(
    eq(notes.userId, userId),
    args.categoryId ? eq(notes.categoryId, args.categoryId) : undefined,
    args.includeArchived ? undefined : eq(notes.isArchived, false),
    args.search
      ? ilike(notes.title, `%${args.search}%`)
      : undefined
  );

  const rows = await db
    .select()
    .from(notes)
    .where(where)
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .limit(args.limit);

  // naive cursor: client can pass last id to fetch next chunk
  return {
    items: rows,
    nextCursor: rows.length === args.limit ? rows[rows.length - 1].id : null,
  };
}

export async function getNote(id: string) {
  const userId = requireUserId();
  const row = await db.query.notes.findFirst({
    where: and(eq(notes.id, id), eq(notes.userId, userId)),
  });
  if (!row) throw new Error('NOT_FOUND');
  return row;
}

export async function updateNote(input: unknown) {
  const userId = requireUserId();
  const data = updateNoteSchema.parse(input);

  if (data.categoryId !== undefined && data.categoryId !== null) {
    const cat = await db.query.categories.findFirst({
      where: and(eq(categories.id, data.categoryId), eq(categories.userId, userId)),
      columns: { id: true },
    });
    if (!cat) throw new Error('CATEGORY_NOT_FOUND');
  }

  const now = new Date();
  const where = and(
    eq(notes.id, data.id),
    eq(notes.userId, userId),
    data.ifUpdatedAt ? eq(notes.updatedAt, new Date(data.ifUpdatedAt)) : undefined
  );

  const [row] = await db
    .update(notes)
    .set({
      title: data.title,
      content: data.content as any,
      plainText: data.plainText,
      categoryId: data.categoryId ?? null,
      isArchived: data.isArchived,
      updatedAt: now,
    })
    .where(where)
    .returning();

  if (!row) {
    // either not found or conflict
    throw new Error(data.ifUpdatedAt ? 'CONFLICT' : 'NOT_FOUND');
  }

  revalidatePath('/notes');
  return row;
}

export async function deleteNote(id: string) {
  const userId = requireUserId();
  const [row] = await db
    .delete(notes)
    .where(and(eq(notes.id, id), eq(notes.userId, userId)))
    .returning({ id: notes.id });

  if (!row) throw new Error('NOT_FOUND');

  revalidatePath('/notes');
  return { success: true };
}
```

```typescript
// /actions/categories.ts
'use server';

import { db } from '@/db';
import { categories, notes } from '@/db/schema/notes';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireUserId } from '@/lib/auth';
import { createCategorySchema, updateCategorySchema } from '@/lib/validation/notes';

export async function createCategory(input: unknown) {
  const userId = requireUserId();
  const data = createCategorySchema.parse(input);

  const [row] = await db
    .insert(categories)
    .values({
      userId,
      name: data.name,
      color: data.color,
    })
    .onConflictDoNothing({ target: [categories.userId, categories.name] })
    .returning();

  if (!row) {
    throw new Error('CATEGORY_ALREADY_EXISTS');
  }
  revalidatePath('/notes');
  return row;
}

export async function listCategories() {
  const userId = requireUserId();
  return db.query.categories.findMany({
    where: eq(categories.userId, userId),
    orderBy: (t, { asc }) => [asc(t.name)],
  });
}

export async function updateCategory(input: unknown) {
  const userId = requireUserId();
  const data = updateCategorySchema.parse(input);

  const [row] = await db
    .update(categories)
    .set({ name: data.name, color: data.color, updatedAt: new Date() })
    .where(and(eq(categories.id, data.id), eq(categories.userId, userId)))
    .returning();

  if (!row) throw new Error('NOT_FOUND');

  revalidatePath('/notes');
  return row;
}

export async function deleteCategory(id: string) {
  const userId = requireUserId();

  // Ensure category belongs to user
  const cat = await db.query.categories.findFirst({
    where: and(eq(categories.id, id), eq(categories.userId, userId)),
    columns: { id: true },
  });
  if (!cat) throw new Error('NOT_FOUND');

  // Null category on notes first (as per acceptance criteria)
  await db
    .update(notes)
    .set({ categoryId: null })
    .where(and(eq(notes.categoryId, id), eq(notes.userId, userId)));

  await db.delete(categories).where(and(eq(categories.id, id), eq(categories.userId, userId)));

  revalidatePath('/notes');
  return { success: true };
}
```

#### Components Structure
Client/UI components consume these actions; this feature focuses on persistence. Suggested minimal structure for integration:

```
/components/notes/
├── notes-provider.tsx           // Server Component: fetches categories and initial notes
├── notes-list.tsx               // Client Component: renders list, calls listNotes on filters
├── note-editor.tsx              // Client Component: TipTap editor, calls create/updateNote
├── category-manager.tsx         // Client Component: manage categories via actions
└── delete-note-button.tsx       // Client Component: calls deleteNote
```

- notes-provider.tsx uses db (server) to fetch user-scoped data for the page.
- Client components import server actions and call them within form actions or startTransition.

#### State Management
- Server-side state: Data fetching for initial render via Server Components (notes-provider).
- Mutations: Next.js Server Actions with revalidatePath('/notes') to refresh caches and RSC payloads.
- Client-side state: Zustand (optional) to manage editor state (current note draft, selection). No sensitive data stored client-side.
- Optimistic UI: For quick feedback, use React startTransition and optimistic updates in client components; on error, rollback and show toast.

### Dependencies & Integrations
- Integrates with Clerk.dev: requireUserId() uses @clerk/nextjs/server to scope all data per user.
- Uses Drizzle ORM for schema, migrations, and runtime queries.
- Supabase: stores data in Postgres via DATABASE_URL.
- Next.js Server Actions for all write operations; App Router for data fetching.
- Additional npm packages:
  - zod: input validation.
  - postgres: database driver for Drizzle.
  - drizzle-kit: migrations (dev dependency).
- Future integration: Whop (if gating premium features) can filter features but not required here.
- TipTap: content stored as JSONB; editor interacts via note-editor component.

Environment variables (set in Vercel and local .env):
- DATABASE_URL=<supabase postgres connection string with SSL>
- CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (from existing auth setup)

### Implementation Steps
1. Create database schema
   - Add /db/schema/notes.ts with notes and categories tables as above.
   - Update /db/index.ts to initialize Drizzle with postgres driver.
   - Create drizzle.config.ts for drizzle-kit (if not present) pointing to DATABASE_URL.
2. Generate queries
   - Run drizzle-kit generate and push:
     - npx drizzle-kit generate
     - npx drizzle-kit push
   - Verify tables and indexes in Supabase.
3. Implement server actions
   - Add validation schemas under /lib/validation/notes.ts.
   - Add actions in /actions/notes.ts and /actions/categories.ts with 'use server' and Clerk auth.
   - Ensure all where clauses include userId; implement optimistic concurrency via ifUpdatedAt.
4. Build UI components (integration stubs)
   - Create server component /components/notes/notes-provider.tsx that queries db.query.notes and db.query.categories for initial data.
   - Client components call server actions and handle optimistic UI (out of scope to fully implement here).
5. Connect frontend to backend
   - In the notes page (e.g., /app/notes/page.tsx), render notes-provider and pass data to client components.
   - Use revalidatePath('/notes') in actions to refresh RSC data.
6. Add error handling
   - Catch and classify errors in client (e.g., NOT_FOUND, CONFLICT, CATEGORY_ALREADY_EXISTS).
   - Log server-side errors with console.error or the app-wide logger; do not leak stack traces to users.
7. Test the feature
   - Write unit tests for validation schemas and action guards.
   - Write integration tests for server actions against a test DB.
   - Manual UAT to verify flows in the app.

Additional Security/DB notes:
- Using DATABASE_URL connects as a privileged DB role; RLS policies may not apply. Therefore, always scope queries by userId and avoid exposing raw IDs to unauthorized users.
- If you prefer RLS enforcement, use the Supabase JS client with row-level security and a per-request JWT; keep Drizzle for schema/migrations. This PRD uses Drizzle runtime queries; ensure comprehensive where clauses.

### Edge Cases & Error Handling
- Unauthorized access: requireUserId throws 'UNAUTHORIZED' if no session. Client should redirect to sign-in.
- Accessing another user’s note: Queries include userId; no rows returned -> throw 'NOT_FOUND'.
- Category not found: When assigning/updating categoryId, validate ownership; else 'CATEGORY_NOT_FOUND'.
- Duplicate category name: onConflictDoNothing -> throw 'CATEGORY_ALREADY_EXISTS'.
- Concurrency conflict: updateNote with ifUpdatedAt mismatch -> throw 'CONFLICT'. Client should prompt to reload.
- Large payloads: plainText length capped; content must be JSON. Reject invalid or excessively large content.
- Deleting category with notes: set categoryId to null on those notes before deletion.
- Invalid UUIDs: Zod validation fails -> user-visible validation error.
- Pagination: If cursor not found or malformed, ignore and start from latest.
- Database connectivity issues: Throw generic 'SERVER_ERROR'; log details server-side.
- Injection attempts: Drizzle parameterization mitigates SQL injection; still validate all inputs.

### Testing Approach
- Unit tests
  - Validation: createNoteSchema, updateNoteSchema, createCategorySchema with valid/invalid payloads.
  - Auth guard: requireUserId returns userId or throws.
- Integration tests
  - create/list/update/delete note flows scoped by userId; ensure cross-user access is denied.
  - Category lifecycle: create, rename, delete; notes’ categoryId set to null on delete.
  - Concurrency: Attempt update with stale ifUpdatedAt -> expect CONFLICT.
  - Search/filter/pagination: verify limits, cursors, and filters.
- User acceptance tests
  - Create a note with a new category; see it appear in the list without reload.
  - Update note title/content; confirm changes persist and render on refresh.
  - Delete a note; confirm it disappears and cannot be fetched.
  - Create duplicate category name; see proper error.
  - Assign note to category; filter by category and see correct results.

This PRD defines the database integration layer for Simple Note Taker using CodeSpring’s stack, ready for engineers to implement and ship.


