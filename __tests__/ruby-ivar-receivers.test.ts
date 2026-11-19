/**
 * A Ruby call on an instance variable, like `@writer.flush`, links to the
 * method of the class the class's `initialize` gives the variable:
 * `@writer = CacheWriter.new` makes it a `CacheWriter`. Before, no call on an
 * instance variable linked at all.
 *
 * For constructor inference, only `initialize` is read, and only a lone `Const.new(…)` types the
 * variable there: one assigned two classes, a conditional, a value passed
 * through `.tap`, or anything but `.new` leaves it untyped, and a class the
 * project doesn't declare (`Logger.new($stdout)`) links nothing. A class
 * method's `@x` is the class's own, and a module's methods run on whatever
 * includes it, so neither is typed.
 *
 * Runs on the native kernel (skipped when none is built) and the wasm
 * extractor.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getKernel } from '../src/extraction/kernel/loader';

const FILES: Record<string, string> = {
  'app/writer.rb': `class CacheWriter
  def flush
    nil
  end

  def ready?
    true
  end
end

class OtherWriter
  def flush
    nil
  end
end

module Billing
  class Card
    def charge!(amount)
      amount
    end
  end

  class Ledger < Card
  end
end
`,
  'app/holder.rb': `class Holder
  def initialize(key)
    @writer = CacheWriter.new
    @lazy ||= OtherWriter.new(
      key
    )
    @either = key ? CacheWriter.new : OtherWriter.new
    @twice = CacheWriter.new
    @twice = OtherWriter.new if key
    @ledger = Billing::Ledger.new key do |l|
      l
    end
    @tapped = CacheWriter.new.tap { |w| w }
    @outside = Logger.new($stdout)
    @a, @b = CacheWriter.new, OtherWriter.new
  end

  def via_ivar
    @writer.flush
    @writer.ready?
    @lazy.flush
    @either.flush
    @twice.flush
    @ledger.charge!(1)
    @tapped.flush
    @outside.info("x")
    @b.flush
    @unset.flush
  end

  def self.klass
    @writer.flush
  end
end

module Mixin
  def mixed
    @writer.flush
  end
end
`,
  'app/models/record.rb': `class ApplicationRecord
end
class Record < ApplicationRecord
  def publish!
  end
  scope :in_account, ->(id) { where account_id: id }
end
`,
  'app/controllers/records_controller.rb': `class RecordsController < ApplicationController
  before_action :load_record, except: [:create,
                                       :index]
  def publish
    @record.publish!
  end

  def create
    @record = current_user.records.build
    @record.publish!
  end

  private

  def load_record
    @record = Record.where(account_id: current_account.id).find params[:id]
  end
end
`,
  'app/controllers/scoped_records_controller.rb': `class ScopedRecordsController < ApplicationController
  before_action :load_record,
                only: %i[ publish show ]

  def publish
    @record.publish!
    respond_with(@record, location: :records)
  end

  def new
    @record = Record.new
    @record.publish!
  end

  def load_record
    @record = Record.in_account(Current.account.id).find(params[:id])
  end
end
`,
  'app/controllers/helper_records_controller.rb': `class HelperRecordsController < ApplicationController
  before_action :load_record, only: %w[publish]

  def publish
    @record.publish!
  end

  private

  def record_scope
    Record.where(account_id: current_account.id)
  end

  def load_record
    @record = record_scope.find(params[:id])
  end
end
`,
  'app/controllers/other_records_controller.rb': `class OtherRecordsController < ApplicationController
  before_action :load_record, only: [:publish]

  def publish
    @record = current_user.records.build
    @record.publish!
  end

  def load_record
    @record = Record.find(params[:id])
  end
end
`,
  'app/models/member.rb': `class Member < ApplicationRecord
  has_many :drafts, class_name: 'Record'
end
`,
  'app/controllers/drafts_controller.rb': `class DraftsController < ApplicationController
  def create
    member = members.find(params[:id])
    @draft = member.drafts.build(
      title: params[:title]
    )
    @draft.publish!
  end

  def replace
    member = members.find(params[:id])
    member = current_user
    @draft = member.drafts.build(title: params[:title])
    @draft.publish!
  end

  def members
    Member.where(active: true)
  end
end
`,
  ...Object.fromEntries([true, false].map((ordered) => [
    `app/controllers/${ordered ? 'ordered' : 'reversed'}_controller.rb`,
    `class ${ordered ? 'Ordered' : 'Reversed'}Controller < ApplicationController
  ${ordered ? 'before_action :scope_records' : 'before_action :load_record, except: [:index]'}
  ${ordered ? 'before_action :load_record, except: [:index]' : 'before_action :scope_records'}
  def publish
    @record.publish!
  end

  def index
    @records = @records.where(active: true)
  end

  def scope_records
    @records = Record.where(id: permitted_ids.to_a())
  end

  def load_record
    @record = @records.find(params[:id])
  end
end
`,
  ])),
  ...Object.fromEntries(['Shared', 'Conflicting', 'Reassigned'].map((variant) => [
    `app/controllers/${variant.toLowerCase()}_records_controller.rb`,
    `class ${variant}RecordsController < ApplicationController
  before_action :load_record, only: %w[update]

  def create
    @record = records.new
    unless persist_record
      render :new
    end
  end

  def update
${variant === 'Reassigned' ? '    @record = params[:record]' : ''}
    unless persist_record
      render :edit
    end
  end

  private

  def persist_record
    @record.publish!
  end

  def load_record
    @record = ${variant === 'Conflicting' ? 'OtherRecord' : 'records'}.find params[:id]
  end

  def records
    Record.where(active: true)
  end
end
`,
  ])),
  'app/models/other_record.rb': `class OtherRecord < ApplicationRecord
  def publish!
  end
end
`,
  ...Object.fromEntries(['Own', 'Foreign'].flatMap((kind) => [
    [`app/models/${kind.toLowerCase()}_record.rb`, `class ${kind}Record < ApplicationRecord
  def self.visible
    base = ${kind === 'Foreign' ? 'OtherRecord.' : ''}where(active: true)
    base.or(extra)
  end

  def self.extra
    ${kind === 'Foreign' ? 'OtherRecord.' : ''}where(active: false)
  end

  def publish!
  end
end
`],
    [`app/controllers/${kind.toLowerCase()}_scope_controller.rb`, `class ${kind}ScopeController < ApplicationController
  before_action :load_record

  def show
    @record.publish!
  end

  def update
    transition(:open)
  end

  private

  def transition(state)
    if @record.publish!
      render state
    end
  end

  def load_record
    @record = ${kind}Record.visible.find(params[:id])
  end
end
`],
  ])),
};

let root = '';
let cg: CodeGraph | undefined;
let savedKernel: string | undefined;

afterEach(() => {
  cg?.close();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
  if (savedKernel === undefined) delete process.env.CODEGRAPH_KERNEL;
  else process.env.CODEGRAPH_KERNEL = savedKernel;
});

async function index(backend: string): Promise<CodeGraph> {
  savedKernel = process.env.CODEGRAPH_KERNEL;
  if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
  else delete process.env.CODEGRAPH_KERNEL;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ruby-ivar-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
  return cg;
}

/** `<qualified name>:<line>` of every `calls` edge written on `line` of `file`. */
function callsAt(graph: CodeGraph, file: string, line: number): string[] {
  const ids = graph.getNodesInFile(file).map((n) => n.id);
  return graph
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls' && e.line === line)
    .map((e) => {
      const t = graph.getNode(e.target)!;
      return `${t.qualifiedName}:${t.startLine}`;
    })
    .sort();
}

const backends = [
  ['kernel', getKernel() === null],
  ['wasm', false],
] as const;

describe.each(backends)('Ruby calls on an instance variable initialize types (%s)', (backend, skip) => {
  it.skipIf(skip)('links the method of the class initialize constructs', async () => {
    const graph = await index(backend);
    const holder = 'app/holder.rb';
    expect(callsAt(graph, holder, 19)).toEqual(['CacheWriter::flush:2']);
    expect(callsAt(graph, holder, 20)).toEqual(['CacheWriter::ready?:6']);
    // `||=` with its arguments over several lines.
    expect(callsAt(graph, holder, 21)).toEqual(['OtherWriter::flush:12']);
    // A namespaced class, built with a block: the method its superclass has.
    expect(callsAt(graph, holder, 24)).toEqual(['Billing::Card::charge!:19']);
  });

  it.skipIf(skip)('types nothing initialize leaves ambiguous', async () => {
    const graph = await index(backend);
    const holder = 'app/holder.rb';
    for (const line of [22, 23, 25, 27, 28]) expect(callsAt(graph, holder, line)).toEqual([]);
  });

  it.skipIf(skip)('links nothing for a class the project does not declare', async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/holder.rb', 26)).toEqual([]);
  });

  it.skipIf(skip)("leaves a class method's and a module's instance variables untyped", async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/holder.rb', 32)).toEqual([]);
    expect(callsAt(graph, 'app/holder.rb', 38)).toEqual([]);
  });

  it.skipIf(skip)('links an applicable Rails callback without typing excluded actions or competing writes', async () => {
    const graph = await index(backend);
    const controller = 'app/controllers/records_controller.rb';
    expect(callsAt(graph, controller, 5)).toEqual(['Record::publish!:4']);
    expect(callsAt(graph, controller, 10)).toEqual([]);
    expect(callsAt(graph, 'app/controllers/other_records_controller.rb', 6)).toEqual([]);
  });

  it.skipIf(skip)('types an association build only from an unambiguous local lookup', async () => {
    const graph = await index(backend);
    const controller = 'app/controllers/drafts_controller.rb';
    expect(callsAt(graph, controller, 7)).toEqual(['Record::publish!:4']);
    expect(callsAt(graph, controller, 14)).toEqual([]);
  });

  it.skipIf(skip)('follows a relation initialized by an earlier applicable callback only', async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/controllers/ordered_controller.rb', 5)).toEqual(['Record::publish!:4']);
    expect(callsAt(graph, 'app/controllers/reversed_controller.rb', 5)).toEqual([]);
  });

  it.skipIf(skip)('resolves a scoped lookup despite writes in an unrelated action', async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/controllers/scoped_records_controller.rb', 6)).toEqual(['Record::publish!:4']);
  });

  it.skipIf(skip)('resolves a callback lookup through a local relation helper', async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/controllers/helper_records_controller.rb', 5)).toEqual(['Record::publish!:4']);
  });

  it.skipIf(skip)('links a call after an initial controller constructor assignment', async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/controllers/scoped_records_controller.rb', 12)).toEqual(['Record::publish!:4']);
  });

  it.skipIf(skip)('types a private helper only when its action inputs agree', async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/controllers/shared_records_controller.rb', 21)).toEqual(['Record::publish!:4']);
    expect(callsAt(graph, 'app/controllers/conflicting_records_controller.rb', 21)).toEqual([]);
    expect(callsAt(graph, 'app/controllers/reassigned_records_controller.rb', 21)).toEqual([]);
  });

  it.skipIf(skip)('follows a proven model relation through a callback and a symbol-argument helper', async () => {
    const graph = await index(backend);
    for (const line of [5, 15]) {
      expect(callsAt(graph, 'app/controllers/own_scope_controller.rb', line)).toEqual(['OwnRecord::publish!:11']);
      expect(callsAt(graph, 'app/controllers/foreign_scope_controller.rb', line)).toEqual([]);
    }
  });
});
