import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "fs";

const force = process.argv.includes("--force");
const sa = JSON.parse(
  readFileSync(new URL("../serviceAccountKey.json", import.meta.url), "utf8")
);
initializeApp({ credential: cert(sa) });
const db = getFirestore();

// Expected outputs are computed later from `solution` (admin page > Compute outputs).
const q = (id, tier, type, title, prompt, starterCode, sampleInput, hiddenInputs, solution) => ({
  id, tier, type, title, prompt, starterCode, sampleInput,
  sampleOutput: "", hiddenInputs, hiddenOutputs: [], solution,
});
const BLANK = "# Write your program below\n";

const questions = [
  q("q01", 1, "write", "Greeting",
    "Read a person's name and print a greeting in exactly this format: Hello, NAME! (a comma, one space, and an exclamation mark at the end).",
    BLANK, "Asha", ["Ravi", "Meena Kumari", "Zoe"],
    `name = input()
print("Hello, " + name + "!")`),

  q("q02", 1, "fix", "Add Two Numbers",
    "This program should read two whole numbers (one per line) and print their sum like this: Sum: 12. But it prints something strange. Find the bug and fix it.",
    `a = input()
b = input()
print("Sum:", a + b)`,
    "5\n7", ["10\n20", "3\n-8", "100\n250"],
    `a = int(input())
b = int(input())
print("Sum:", a + b)`),

  q("q03", 1, "complete", "Area of a Rectangle",
    "Read the length and the width (whole numbers, one per line) and print the area like this: Area: 24. Replace the blank (____) with the correct expression.",
    `length = int(input())
width = int(input())
area = ____
print("Area:", area)`,
    "4\n6", ["10\n10", "7\n3", "12\n5"],
    `length = int(input())
width = int(input())
area = length * width
print("Area:", area)`),

  q("q04", 1, "write", "Even or Odd",
    "Read a whole number. Print Even if it is divisible by 2, otherwise print Odd.",
    BLANK, "8", ["9", "24", "101"],
    `n = int(input())
if n % 2 == 0:
    print("Even")
else:
    print("Odd")`),

  q("q05", 1, "fix", "Squares up to n",
    "Read a whole number n and print the squares of 1, 2, 3, ... up to n, one per line. For n = 3 the output is 1, 4 and 9 on separate lines. This program stops one number too early. Fix it.",
    `n = int(input())
for i in range(1, n):
    print(i * i)`,
    "5", ["4", "6", "8"],
    `n = int(input())
for i in range(1, n + 1):
    print(i * i)`),

  q("q06", 2, "write", "Largest of Three",
    "Read three whole numbers (one per line) and print the largest one.",
    BLANK, "3\n8\n5", ["12\n45\n30", "9\n2\n5", "-4\n-1\n-8"],
    `a = int(input())
b = int(input())
c = int(input())
print(max(a, b, c))`),

  q("q07", 2, "fix", "Sum from 1 to n",
    "Read a whole number n and print the sum of all the numbers from 1 to n. For n = 4 the answer is 10. This program prints the wrong answer. Fix it.",
    `n = int(input())
total = 0
for i in range(1, n + 1):
    total = i
print(total)`,
    "5", ["10", "100", "3"],
    `n = int(input())
total = 0
for i in range(1, n + 1):
    total += i
print(total)`),

  q("q08", 2, "complete", "Count the Vowels",
    "Read one lowercase word and print how many vowels (a, e, i, o, u) it has. Replace the blank (____) so the program works.",
    `word = input()
count = 0
for ch in word:
    if ch ____ "aeiou":
        count += 1
print(count)`,
    "computer", ["education", "rhythm", "banana"],
    `word = input()
count = 0
for ch in word:
    if ch in "aeiou":
        count += 1
print(count)`),

  q("q09", 2, "write", "Multiplication Table",
    "Read a whole number n and print its first five multiples, one per line, in the format shown in the sample (for example 3 x 1 = 3).",
    BLANK, "3", ["7", "12", "5"],
    `n = int(input())
for i in range(1, 6):
    print(n, "x", i, "=", n * i)`),

  q("q10", 2, "fix", "Grade Calculator",
    "Read the marks (0 to 100) and print the grade: A for 90 or more, B for 75 or more, C for 50 or more, otherwise Fail. This program gives wrong grades for some marks. Fix it.",
    `marks = int(input())
if marks >= 50:
    print("C")
elif marks >= 75:
    print("B")
elif marks >= 90:
    print("A")
else:
    print("Fail")`,
    "82", ["95", "60", "30", "75"],
    `marks = int(input())
if marks >= 90:
    print("A")
elif marks >= 75:
    print("B")
elif marks >= 50:
    print("C")
else:
    print("Fail")`),

  q("q11", 3, "write", "Sum of a List",
    "Read several whole numbers written on one line, separated by spaces, and print their sum. For example 4 8 15 gives 27.",
    "# Hint: input().split() gives a list of the words in a line\n",
    "4 8 15", ["1 2 3 4 5", "10 20 30", "7 7 7 7"],
    `nums = input().split()
total = 0
for x in nums:
    total += int(x)
print(total)`),

  q("q12", 3, "fix", "Prime or Not",
    "Read a whole number n (2 or more) and print Prime if it is a prime number, otherwise print Not prime. This program gives the wrong answer for some numbers. Fix it.",
    `n = int(input())
is_prime = True
for i in range(2, n):
    if n % i == 0:
        is_prime = False
    else:
        is_prime = True
if is_prime:
    print("Prime")
else:
    print("Not prime")`,
    "10", ["13", "15", "29", "49"],
    `n = int(input())
is_prime = True
for i in range(2, n):
    if n % i == 0:
        is_prime = False
if is_prime:
    print("Prime")
else:
    print("Not prime")`),

  q("q13", 3, "complete", "Average of Numbers",
    "Read several whole numbers on one line (separated by spaces) and print their average rounded to 2 decimal places. Replace the blank (____) with the correct code.",
    `nums = input().split()
total = 0
for x in nums:
    total += ____
average = total / len(nums)
print(round(average, 2))`,
    "4 8 15 16", ["10 20 30", "5 5 5 5", "1 2 4"],
    `nums = input().split()
total = 0
for x in nums:
    total += int(x)
average = total / len(nums)
print(round(average, 2))`),

  q("q14", 3, "write", "Palindrome Check",
    "Read one word. Print Yes if it reads the same forwards and backwards, otherwise print No.",
    "# Hint: word[::-1] reverses a word, or you can use a loop\n",
    "radar", ["hello", "civic", "matrix", "noon"],
    `word = input()
if word == word[::-1]:
    print("Yes")
else:
    print("No")`),

  q("q15", 3, "write", "FizzBuzz",
    "Read a whole number n. For each number from 1 to n print one line: FizzBuzz if it is divisible by both 3 and 5, Fizz if it is divisible by 3 only, Buzz if it is divisible by 5 only, otherwise the number itself.",
    BLANK, "5", ["15", "10", "7"],
    `n = int(input())
for i in range(1, n + 1):
    if i % 15 == 0:
        print("FizzBuzz")
    elif i % 3 == 0:
        print("Fizz")
    elif i % 5 == 0:
        print("Buzz")
    else:
        print(i)`),
];

const bankRef = db.doc("config/relayBank");
if ((await bankRef.get()).exists && !force) {
  console.log("Bank already exists, skipping (use --force to replace it).");
} else {
  await bankRef.set({ questions });
  console.log(`Seeded ${questions.length} questions. Now press "Compute outputs" in Admin > Code Relay.`);
}

const cfgRef = db.doc("config/relay");
if (!(await cfgRef.get()).exists) {
  await cfgRef.set({
    roundId: null, name: "", status: "idle", startedAt: null,
    durationMin: 45, legSec: 300, minPassSec: 60, leaderboard: null,
  });
  console.log("Created config/relay");
}
process.exit(0);