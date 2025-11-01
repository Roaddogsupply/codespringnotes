export type Category = {
  id: string;
  name: string;
  color?: string | null;
};

export type NoteListItem = {
  id: string;
  title: string;
  preview: string;
  updatedAt: string; // ISO string
  categoryId?: string | null;
  categoryName?: string | null;
  categoryColor?: string | null;
};

export const mockCategories: Category[] = [
  { id: "cat-work", name: "Work", color: "#3b82f6" },
  { id: "cat-personal", name: "Personal", color: "#22c55e" },
  { id: "cat-ideas", name: "Ideas", color: "#a855f7" },
];

function generateMockNotes(count = 36): NoteListItem[] {
  const base = [
    "Plan Q4 roadmap and key milestones.",
    "Meeting notes with action items and owners.",
    "Draft blog post about product principles.",
    "Personal reflections on learning TypeScript.",
    "List of feature ideas from user feedback.",
    "Outline for onboarding improvements.",
  ];
  const notes: NoteListItem[] = [];
  for (let i = 0; i < count; i++) {
    const idx = i % base.length;
    const cat = i % 4 === 0 ? mockCategories[0] : i % 4 === 1 ? mockCategories[1] : i % 4 === 2 ? mockCategories[2] : null;
    const hoursAgo = (i + 1) * 6;
    const date = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
    notes.push({
      id: `note-${i + 1}`,
      title: `Note ${i + 1}`,
      preview: base[idx],
      updatedAt: date.toISOString(),
      categoryId: cat?.id ?? null,
      categoryName: cat?.name ?? null,
      categoryColor: cat?.color ?? null,
    });
  }
  return notes;
}

export const mockNotes: NoteListItem[] = generateMockNotes(30);
