/**
 * 全ジョブ種別で共有する admission controller の競合テスト。
 */
import { describe, expect, it } from 'vitest';
import { JobAdmissionController, JobAdmissionRejectedError } from './admission';

describe('JobAdmissionController', () => {
  it('rejects a different manual job when the shared capacity is one', () => {
    const admission = new JobAdmissionController(1);
    const schedule = admission.tryAcquire('schedule', 'schedule-a');

    expect(() => admission.tryAcquire('workflow', 'workflow-b')).toThrowError(
      JobAdmissionRejectedError,
    );
    try {
      admission.tryAcquire('workflow', 'workflow-b');
    } catch (err) {
      expect(err).toMatchObject({ reason: 'capacity' });
    }
    expect(admission.activeCount).toBe(1);

    schedule.release();
    const workflow = admission.tryAcquire('workflow', 'workflow-b');
    expect(admission.activeCount).toBe(1);
    workflow.release();
  });

  it('rejects the same job atomically and releases a lease only once', () => {
    const admission = new JobAdmissionController(2);
    const lease = admission.tryAcquire('alert', 'alert-a');

    expect(() => admission.tryAcquire('alert', 'alert-a')).toThrowError(JobAdmissionRejectedError);
    try {
      admission.tryAcquire('alert', 'alert-a');
    } catch (err) {
      expect(err).toMatchObject({ reason: 'duplicate' });
    }

    lease.release();
    lease.release();
    expect(admission.activeCount).toBe(0);
    admission.tryAcquire('alert', 'alert-a').release();
  });

  it('rejects new jobs after close and resolves idle after the last lease', async () => {
    const admission = new JobAdmissionController(2);
    const lease = admission.tryAcquire('schedule', 'schedule-a');
    admission.stopAccepting();

    expect(() => admission.tryAcquire('workflow', 'workflow-b')).toThrowError(
      expect.objectContaining({ reason: 'closed' }),
    );
    let idle = false;
    const waiting = admission.whenIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    lease.release();
    await waiting;
    expect(idle).toBe(true);
  });

  it('keeps the job claim while sharing statement capacity in FIFO order', async () => {
    const admission = new JobAdmissionController(1);
    const workflow = admission.tryAcquire('workflow', 'workflow-a');
    workflow.releaseCapacity();

    const first = await admission.acquireCapacity();
    let secondAcquired = false;
    const secondPromise = admission.acquireCapacity().then((lease) => {
      secondAcquired = true;
      return lease;
    });
    await Promise.resolve();
    expect(admission.activeCount).toBe(1);
    expect(admission.activeCapacityCount).toBe(1);
    expect(secondAcquired).toBe(false);

    first.release();
    const second = await secondPromise;
    expect(admission.activeCapacityCount).toBe(1);
    second.release();
    workflow.release();
    await admission.whenIdle();
    expect(admission.activeCapacityCount).toBe(0);
  });

  it('removes an aborted statement capacity waiter', async () => {
    const admission = new JobAdmissionController(1);
    const holder = admission.tryAcquire('schedule', 'schedule-a');
    const controller = new AbortController();
    const waiting = admission.acquireCapacity(controller.signal);

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    holder.release();
    await admission.whenIdle();
  });
});
