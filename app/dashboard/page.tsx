/**
 * Dashboard page for Template App
 * Displays the main dashboard interface for authenticated users
 * Features a sidebar navigation and content area
 * Requires a paid membership to access
 */
import DashboardView from "@/components/dashboard/dashboard-view";
import { mockCategories, mockNotes } from "@/lib/mock-data";

/**
 * Main dashboard page component
 * The profile is provided by the parent layout component
 */
export default function DashboardPage() {
  return (
    <main className="p-6 md:p-10">
      <h1 className="mb-6 text-3xl font-bold">Dashboard</h1>
      <DashboardView initialNotes={mockNotes} categories={mockCategories} />
    </main>
  );
}
