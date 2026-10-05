import { ReactNode } from "react";
import RoleGuard from "@/components/role-guard";
// import { ProctorProvider } from "@/lib/proctor"; // TODO: re-enable fullscreen proctoring

export default function StudentsLayout({ children }: { children: ReactNode }) {
  return (
    <RoleGuard role="student">
      {/* <ProctorProvider> */}
      {children}
      {/* </ProctorProvider> */}
    </RoleGuard>
  );
}