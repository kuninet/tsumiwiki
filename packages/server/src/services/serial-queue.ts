// Git操作を直列化するキュー(設計06章6.1)。
// 同時コミットによる index.lock 競合を排除する。
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // 失敗しても後続タスクは実行する
    this.tail = result.catch(() => undefined);
    return result;
  }
}
