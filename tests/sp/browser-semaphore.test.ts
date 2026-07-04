import { describe, it, expect } from "vitest";
import { AsyncSemaphore } from "@/lib/sp/browserSemaphore";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("AsyncSemaphore", () => {
  it("never runs more than `max` tasks at once", async () => {
    const sem = new AsyncSemaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
      });

    await Promise.all(Array.from({ length: 8 }, task));

    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it("serializes fully at max=1", async () => {
    const sem = new AsyncSemaphore(1);
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    await Promise.all(
      [1, 2, 3].map((n) =>
        sem.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await tick();
          order.push(n);
          active--;
        }),
      ),
    );
    expect(peak).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });

  it("releases the slot even when a task throws", async () => {
    const sem = new AsyncSemaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // If the slot leaked, this second acquire would hang forever.
    let ran = false;
    await sem.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("clamps a max below 1 up to 1", async () => {
    const sem = new AsyncSemaphore(0);
    let ran = false;
    await sem.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
