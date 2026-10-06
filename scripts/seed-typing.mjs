// Usage:
//   node scripts/seed-typing.mjs          (skips if the pool already exists)
//   node scripts/seed-typing.mjs --force  (replaces the pool)
// Key location: KEY_PATH env var, or the default below. Never commit the key.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "fs";

const force = process.argv.includes("--force");

const KEY_PATH = process.env.KEY_PATH || "C:/Users/Asus/keys/kcs-key.json";
let sa;
try {
  sa = JSON.parse(readFileSync(new URL("../serviceAccountKey.json", import.meta.url), "utf8"));
  
} catch (e) {
  console.error(`Cannot read key at ${KEY_PATH}:`, e.message);
  process.exit(1);
}
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const P = [
  "Artificial intelligence has moved from research papers into everyday tools, and students are now expected to understand how it works. A model learns patterns from data by adjusting millions of numbers until its predictions improve. The quality of the data matters as much as the size of the model, because a system can only learn what its examples show it. Good engineers test their models on fresh data, watch for bias, and explain their results in plain language. Curiosity, patience, and careful measurement are the habits that turn a clever idea into a reliable product.",
  "Python is popular with beginners because its code reads almost like plain English. A short program can read a file, count the words, and print a summary in just a few lines. Variables hold values, loops repeat actions, and functions package ideas so they can be reused. When a program fails, the error message points to the line that needs attention, and learning to read those messages is a skill worth practicing. Every expert programmer once struggled with a missing colon or a misplaced bracket, and every one of them improved by writing more code every single day.",
  "A message sent across the internet is broken into small packets that travel through many machines before reaching their destination. Each packet carries an address, a number, and a piece of the data, and the receiving computer puts them back in the correct order. Routers decide the best path at every step, even when a cable fails or a server becomes busy. This design makes the network resilient, which is why a video call can continue while some links go down. Behind every simple click there is a careful agreement between thousands of devices about how to talk to each other.",
  "Typing is a skill that grows through steady practice rather than sudden bursts of effort. At first you look at the keys and search for each letter, but with time your fingers remember the positions and your eyes move ahead to the next word. Speed comes as a side effect of accuracy, because every mistake costs more time than a slower, careful stroke. Short daily sessions work better than one long session, and a relaxed posture keeps your hands from tiring. Measure your progress each week, celebrate small gains, and keep going until the keyboard feels like a natural extension of your thoughts.",
  "A good team is more than a group of talented people sitting at the same table. Members share their plans early, ask for help without fear, and listen to ideas that differ from their own. When a deadline is close, clear roles prevent confusion and small updates keep everyone informed. Disagreements are normal, and the best teams settle them by testing options instead of arguing about opinions. Whether the project is a robot, a website, or a research poster, the final result reflects how well the people behind it trusted and supported one another.",
  "Data tells a story only when someone takes the time to clean it, explore it, and ask the right questions. Missing values, duplicate rows, and inconsistent labels can quietly mislead even the most careful analyst. A simple chart often reveals a pattern that pages of numbers hide, such as a steady rise, a sudden drop, or a group that behaves differently from the rest. After the exploration comes the model, but the model is only one step in a longer journey. The final task is to explain the findings so that other people can understand them, trust them, and use them to make better decisions.",
  "Strong security begins with small habits that people repeat every day. A long and unique password, a second step to confirm your identity, and a healthy doubt about unexpected links protect more accounts than any expensive tool. Software updates matter because they close holes that attackers already know how to use. When something looks suspicious, pausing for a moment and asking a friend or a teacher is always better than rushing. Safe computing is not about fear, it is about awareness, and every careful choice makes the whole community a little harder to attack.",
  "Long before telescopes existed, people looked at the night sky and wondered what the bright points of light could be. Today satellites map the ocean floor, probes visit distant moons, and powerful instruments collect light that left its source billions of years ago. Each discovery raises new questions, and science moves forward by testing ideas against evidence. A theory that fails an experiment is not a disaster, it is a useful clue that points the way to a better explanation. Young students who keep asking why are carrying that same tradition of curiosity into the future.",
  "The modern web is built from layers that cooperate quietly in the background. A browser asks a server for a page, the server replies with markup, styles, and scripts, and the browser turns them into the buttons and images you see. Frameworks help developers organise this work, but the basic ideas remain the same: structure, appearance, and behaviour. Open source projects let thousands of strangers improve the same tools, review each other's code, and fix problems quickly. Anyone with a laptop and some patience can read the source, learn from it, and one day contribute a change of their own.",
  "Preparing for an exam is easier when the work is spread across many days instead of crammed into one night. Begin by listing the topics, mark the ones that feel difficult, and give those extra time at the start of the week. Explaining an idea out loud to a friend is a powerful test, because gaps in understanding show up quickly. Sleep and meals are part of the plan, since a tired mind forgets what a rested mind could easily recall. On the day itself, read every question twice, begin with the ones you know, and keep an eye on the clock without letting it rush you.",
  "A robot is a machine that senses the world, makes a decision, and then acts on it. Sensors measure distance, light, or movement, a controller processes those signals, and motors turn the decision into motion. Engineers test each part separately, then combine them and watch for surprises, because small errors add up quickly in the real world. Simple tasks such as following a line or avoiding a wall teach the same lessons as larger machines in factories and hospitals. Building a robot is a patient mixture of mathematics, design, and trial and error, and nothing beats the joy of seeing your own creation move for the first time.",
  "A college community grows stronger when students share what they know. A club meeting, a weekend workshop, or a friendly competition gives people a chance to practice skills that classrooms rarely have time to cover. Beginners learn faster when they sit next to someone who has already made the same mistakes, and experienced members gain a deeper understanding by teaching. Events like these also create friendships that last long after the semester ends. The next time an invitation appears on your screen, consider saying yes, because the most valuable lessons often arrive when you try something unfamiliar with people who are willing to learn alongside you.",
];

// lowercase, letters/numbers/spaces only, single spaces
const clean = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const CLEAN_P = P.map(clean);

// 12 + 8 = 20 different passages, each built from 3 paragraphs
const combos = [];
for (let a = 0; a < 12; a++) combos.push([a, (a + 4) % 12, (a + 8) % 12]);
for (let a = 0; a < 8; a++) combos.push([a, (a + 3) % 12, (a + 7) % 12]);
const passages = combos.map((c, i) => ({
  id: `p${String(i + 1).padStart(2, "0")}`,
  text: c.map((k) => CLEAN_P[k]).join(" "),
}));

try {
  // safety check: nothing but lowercase letters, digits and single spaces
  console.log("Sample:", passages[0].text.slice(0, 120));
  if (passages.some((p) => !/^[a-z0-9]+( [a-z0-9]+)*$/.test(p.text))) {
    console.error("Passages still contain caps or punctuation, aborting.");
    process.exit(1);
  }

  const poolRef = db.doc("config/typingPool");
  const pool = await poolRef.get();
  if (pool.exists && !force) {
    console.log("Pool already exists, skipping (use --force to replace it).");
  } else {
    await poolRef.set({ passages });
    console.log(`Seeded ${passages.length} passages`);
  }

  const cfgRef = db.doc("config/typing");
  if (!(await cfgRef.get()).exists) {
    await cfgRef.set({
      roundId: null,
      name: "",
      durationSec: 120,
      status: "idle",
      startedAt: null,
      leaderboard: null,
    });
    console.log("Created config/typing");
  }
  process.exit(0);
} catch (e) {
  console.error("SEED FAILED:", e.message);
  process.exit(1);
}