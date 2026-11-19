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

  def default_value(value = consume(subtotal))
    consume(subtotal)
    value
  end

  def after_block_parameter
    [1].each { |subtotal| subtotal + 1 }
    subtotal + 1
  end

  def returned
    return subtotal
  end

  def argument
    consume(subtotal)
  end

  def returned_parameter(subtotal)
    return subtotal
  end

  def argument_local
    subtotal = 4
    consume(subtotal)
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
      'Item::after_block_parameter -> Item::subtotal',
      'Item::argument -> Item::subtotal',
      'Item::assign_attribute -> Item::subtotal',
      'Item::assign_local -> Item::subtotal',
      'Item::default_value -> Item::subtotal',
      'Item::returned -> Item::subtotal',
      'Item::standalone_call -> Item::subtotal',
      'Item::tax -> Item::subtotal',
      'Item::total -> Item::subtotal',
      'Item::total -> Item::tax',
      'Item::totals -> Item::subtotal',
    ]);
    const blockMethod = methods.find((method) => method.qualifiedName === 'Item::after_block_parameter')!;
    const subtotalEdges = graph.getOutgoingEdgesFrom([blockMethod.id])
      .filter((edge) => edge.kind === 'calls' && graph.getNode(edge.target)?.qualifiedName === 'Item::subtotal');
    expect(subtotalEdges.map((edge) => edge.line)).toEqual([48]);
  });
});
