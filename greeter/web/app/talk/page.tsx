import type { Metadata } from "next";
import Stage from "./stage";

export const metadata: Metadata = {
  title: "Screen",
  description: "Type what the greeter's voice would ask for, and watch the screen it builds.",
};

export default function Page() {
  return <Stage />;
}
