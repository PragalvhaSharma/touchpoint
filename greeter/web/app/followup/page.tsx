// The booth follow-up on a full page. ?mock runs the scripted demo (add &fail=1 to see the backup take over,
// &speed=2 to run it faster); ?person=<Slack user id> runs the real follow-up (&to=<email>, &send=0 to hold it).
import type { Metadata } from "next";
import { Suspense } from "react";
import { FollowUpScreen } from "../live/followup";

export const metadata: Metadata = { title: "Follow-up" };

export default function FollowUpPage({ searchParams }: PageProps<"/followup">) {
  // The query is request data, so it is read inside Suspense (cacheComponents prerenders the shell).
  return (
    <Suspense fallback={<main className="min-h-full bg-bg" />}>
      <Screen searchParams={searchParams} />
    </Suspense>
  );
}

async function Screen({ searchParams }: Pick<PageProps<"/followup">, "searchParams">) {
  const q = await searchParams;
  const one = (k: string) => {
    const v = q[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const person = one("person") || undefined;
  const mock = one("mock") !== undefined && !person;
  const send = one("send");
  const speed = Number(one("speed")) || undefined;
  return (
    <FollowUpScreen
      mock={mock}
      fail={one("fail") === "1"}
      person={person}
      to={one("to") || undefined}
      send={send === undefined ? undefined : send !== "0" && send !== "false"}
      speed={speed}
    />
  );
}

