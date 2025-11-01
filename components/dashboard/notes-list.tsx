"use client";

import { motion, AnimatePresence } from "framer-motion";
import NoteCard from "./note-card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import Skeletons from "./skeletons";

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
