import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root: string;
let graph: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ruby-bare-'));
  fs.writeFileSync(path.join(root, 'item.rb'), `class Item
  def subtotal
    10
  end

  def tax = subtotal * 0.15

  def total
    subtotal + tax
  end

  def totals
    { subtotal: subtotal }
  end

  def shadowed_hash(subtotal)
    { subtotal: subtotal }
  end

  def assign_attribute
    self.subtotal = subtotal
  end

  def assign_local
    result = subtotal
  end

  def assign_shadowed(subtotal)
    result = subtotal
  end

  def assign_local_shadow
    subtotal = 4
    result = subtotal
  end

  def standalone_call
    subtotal
  end

  def standalone_parameter(subtotal)
    subtotal
  end

  def standalone_local
    subtotal = 4
    subtotal
  end

  def with_parameter(subtotal)
    subtotal + 1
  end

  def with_local
    subtotal = 4
    subtotal + 1
  end
end

class Unrelated
  def subtotal
    20
  end
end
`);
  graph = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  graph?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('Ruby bare method calls', () => {
  it('resolves calls in ordinary and endless methods to the owning class', () => {
    const nodes = graph.getNodesInFile('item.rb');
    const methods = nodes.filter((node) => node.kind === 'method');
    const calls = methods.flatMap((method) => graph.getOutgoingEdgesFrom([method.id])
      .filter((edge) => edge.kind === 'calls')
      .map((edge) => `${method.qualifiedName} -> ${graph.getNode(edge.target)?.qualifiedName}`));
    expect(calls.sort()).toEqual([
      'Item::assign_attribute -> Item::subtotal',
      'Item::assign_local -> Item::subtotal',
      'Item::standalone_call -> Item::subtotal',
      'Item::tax -> Item::subtotal',
      'Item::total -> Item::subtotal',
      'Item::total -> Item::tax',
      'Item::totals -> Item::subtotal',
    ]);
  });
});
