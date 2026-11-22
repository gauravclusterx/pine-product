import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { SessionProvider } from "./lib/session";
import { AdminLayout, AppLayout } from "./components/Layout";
import { Loading } from "./components/ui";
import Login from "./pages/Login";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const Agents = lazy(() => import("./pages/Agents"));
const AgentEditor = lazy(() => import("./pages/AgentEditor"));
const Calls = lazy(() => import("./pages/Calls"));
const CallDetail = lazy(() => import("./pages/CallDetail"));
const Leads = lazy(() => import("./pages/Leads"));
const Customers = lazy(() => import("./pages/Customers"));
const CustomerDetail = lazy(() => import("./pages/Customers").then((m) => ({ default: m.CustomerPage })));
const Bookings = lazy(() => import("./pages/Bookings"));
const Campaigns = lazy(() => import("./pages/Campaigns"));
const Numbers = lazy(() => import("./pages/Numbers"));
const Integrations = lazy(() => import("./pages/Integrations"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const AdminOverview = lazy(() => import("./pages/Admin").then((m) => ({ default: m.AdminOverview })));
const AdminSystem = lazy(() => import("./pages/Admin").then((m) => ({ default: m.AdminSystem })));
const AdminCustomers = lazy(() => import("./pages/AdminBilling").then((m) => ({ default: m.AdminCustomers })));
const AdminPayments = lazy(() => import("./pages/AdminBilling").then((m) => ({ default: m.AdminPayments })));
const AdminSettings = lazy(() => import("./pages/AdminBilling").then((m) => ({ default: m.AdminSettings })));
const BillingPage = lazy(() => import("./pages/Billing"));

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 } } });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <SessionProvider>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<Navigate to="/app" replace />} />
              <Route path="/login" element={<Login />} />
              <Route path="/app" element={<AppLayout />}>
                <Route index element={<Dashboard />} />
                <Route path="agents" element={<Agents />} />
                <Route path="agents/:id" element={<AgentEditor />} />
                <Route path="calls" element={<Calls />} />
                <Route path="calls/:id" element={<CallDetail />} />
                <Route path="leads" element={<Leads />} />
                <Route path="customers" element={<Customers />} />
                <Route path="customers/:id" element={<CustomerDetail />} />
                <Route path="bookings" element={<Bookings />} />
                <Route path="campaigns" element={<Campaigns />} />
                <Route path="numbers" element={<Numbers />} />
                <Route path="integrations" element={<Integrations />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="billing" element={<BillingPage />} />
                <Route path="admin" element={<Navigate to="/admin" replace />} />
              </Route>
              <Route path="/admin" element={<AdminLayout />}>
                <Route index element={<AdminOverview />} />
                <Route path="customers" element={<AdminCustomers />} />
                <Route path="clients" element={<Navigate to="/admin/customers" replace />} />
                <Route path="payments" element={<AdminPayments />} />
                <Route path="settings" element={<AdminSettings />} />
                <Route path="system" element={<AdminSystem />} />
              </Route>
              <Route path="*" element={<Navigate to="/app" replace />} />
            </Routes>
          </Suspense>
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
