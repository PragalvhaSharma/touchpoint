// The Hack Western 13 sponsors the greeter matches people to. Each entry is a careers site the TinyFish agent
// can open; searchUrl (with {q}) starts it on search results, which saves most of its steps.
// `hires` is one line on what they hire for, so the matcher can pick the sponsor that fits what someone builds.
import type { Booth } from "./types";

export type Sponsor = Omit<Booth, "recruiter"> & { hires: string };

export const SPONSORS: Sponsor[] = [
  { company: "Scotiabank", careersUrl: "https://jobs.scotiabank.com/", searchUrl: "https://jobs.scotiabank.com/search/?q={q}&locale=en_US", hires: "Title sponsor. Bank: software, data, AI/ML, cloud, cybersecurity, quant and finance co-ops and new grads in Toronto." },
  { company: "Manulife", careersUrl: "https://careers.manulife.com/", searchUrl: "https://careers.manulife.com/global/en/search-results?keywords={q}", hires: "Insurance and asset management: software, data science, AI, actuarial and finance co-ops and new grads in Toronto and Waterloo." },
  { company: "Shopify", careersUrl: "https://www.shopify.com/careers", searchUrl: "https://www.shopify.com/careers?keywords={q}", hires: "Commerce platform: product engineering, web and mobile apps, developer tools, ML and data; engineering interns." },
  { company: "Autodesk", careersUrl: "https://autodesk.wd1.myworkdayjobs.com/en-US/Ext", site: "autodesk.com", searchUrl: "https://autodesk.wd1.myworkdayjobs.com/en-US/Ext?q={q}", hires: "Design and 3D software: CAD, graphics, geometry, AR/VR, simulation, AI for design; Toronto interns." },
  { company: "OpenAI", careersUrl: "https://openai.com/careers/", searchUrl: "https://openai.com/careers/search/?q={q}", hires: "Frontier AI lab in San Francisco: mostly experienced ML researchers and engineers, a few new-grad roles; fits people who train models or build deep LLM infrastructure." },
  { company: "DoorDash", careersUrl: "https://careersatdoordash.com/", searchUrl: "https://careersatdoordash.com/job-search/?keyword={q}", hires: "Delivery logistics: backend, mobile, ML for logistics and ads, data; Toronto engineering interns." },
  { company: "Accenture", careersUrl: "https://www.accenture.com/ca-en/careers", searchUrl: "https://www.accenture.com/ca-en/careers/jobsearch?jk={q}", hires: "Consulting and tech services: business and technology analysts, cloud, data and AI consulting, strategy." },
  { company: "Commure", careersUrl: "https://jobs.ashbyhq.com/commure", site: "commure.com", hires: "Healthcare AI: ambient clinical documentation, voice agents, healthcare software and AI operations." },
  { company: "TinyFish", careersUrl: "https://jobs.dover.com/tinyfish", site: "tinyfish.ai", hires: "Web agents: AI agents that browse and act on the web, data infrastructure, DevOps, business development interns." },
  { company: "CSE", careersUrl: "https://www.cse-cst.gc.ca/en/careers", hires: "Communications Security Establishment Canada: cybersecurity, cryptography, networks, data science, students (Canadian citizens)." },
  { company: "StarTech", careersUrl: "https://www.startech.com/en-ca/about/careers", hires: "Connectivity hardware in London, Ontario: hardware and firmware, embedded, IT, e-commerce and supply chain." },
];

export const SPONSOR_NAMES = SPONSORS.map((s) => s.company) as [string, ...string[]];

export function sponsor(name: string | undefined): Sponsor | undefined {
  const n = (name ?? "").toLowerCase();
  return SPONSORS.find((s) => s.company.toLowerCase() === n);
}
