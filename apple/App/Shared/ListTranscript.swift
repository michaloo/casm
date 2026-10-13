import CasmKit
import QuartzCore
import SwiftUI

/// The transcript as a table-backed `List` (NSTableView / UICollectionView with cell reuse),
/// the alternative to the ScrollView + LazyVStack in ChatView.
struct ListTranscript: View {
    @Bindable var chat: ChatModel

    var body: some View {
        ScrollViewReader { proxy in
            List {
                if chat.canLoadOlder {
                    ProgressView()
                        .controlSize(.small)
                        .frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden)
                        .onAppear {
                            let anchor = chat.visibleItems.first?.id
                            Task {
                                #if DEBUG && os(macOS)
                                let t0 = CACurrentMediaTime(), before = chat.visibleItems.count
                                #endif
                                await chat.revealOlder()
                                #if DEBUG && os(macOS)
                                DebugControl.shared.afterIdle {
                                    DebugControl.shared.log(String(format: "reveal %d→%d rows: %.0f ms", before, chat.visibleItems.count, (CACurrentMediaTime() - t0) * 1000))
                                }
                                #endif
                                // After the table has applied the new rows.
                                try? await Task.sleep(for: .milliseconds(1))
                                if let anchor { proxy.scrollTo(anchor, anchor: .top) }
                            }
                        }
                        .id("older-\(chat.windowStart)-\(chat.historyStart ?? 0)")
                }
                ForEach(chat.visibleItems) { item in
                    ItemRow(item: item, expanded: $chat.expanded)
                        .frame(maxWidth: 900, alignment: .leading)
                        .frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 7, leading: 20, bottom: 7, trailing: 20))
                }
                if let draft = chat.draft {
                    DraftRow(draft: draft)
                        .frame(maxWidth: 900, alignment: .leading)
                        .frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 7, leading: 20, bottom: 7, trailing: 20))
                        .id("draft")
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .defaultScrollAnchor(.bottom)
            .accessibilityIdentifier("transcript")
            .onChange(of: chat.scrollToBottomRequest) {
                if let last = chat.items.last?.id { proxy.scrollTo(last, anchor: .bottom) }
            }
        }
    }
}
