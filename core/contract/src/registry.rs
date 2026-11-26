//! Every check and the sentences of `STORAGE.md` it decides. The unit test in `lib.rs` keeps this
//! table and `sentences::SENTENCES` in step: every checkable sentence has a check, every check
//! names real sentences.

use crate::Check;
use crate::checks::*;

macro_rules! check {
    ($module:ident :: $name:ident, [$($id:literal),+ $(,)?]) => {
        Check { name: stringify!($name), sentences: &[$($id),+], serial: false, run: $module::$name }
    };
    (serial $module:ident :: $name:ident, [$($id:literal),+ $(,)?]) => {
        Check { name: stringify!($name), sentences: &[$($id),+], serial: true, run: $module::$name }
    };
}

pub const CHECKS: &[Check] = &[
    // Preamble and words
    check!(
        basics::describe_names_contract_1_and_addresses,
        ["0.5", "0.7"]
    ),
    check!(basics::every_op_is_a_subcommand, ["0.8"]),
    check!(basics::serve_answers_like_one_shot, ["0.8", "6.serve.1"]),
    check!(
        basics::malformed_places_are_bad_requests,
        ["1.place", "8.bad_request"]
    ),
    check!(basics::kinds_are_file_dir_other_none, ["1.kind"]),
    check!(basics::the_two_halves_do_not_mix, ["1.storage"]),
    check!(basics::a_token_handed_back_is_the_same, ["1.token"]),
    check!(basics::cursors_are_text, ["1.cursor"]),
    check!(basics::record_places_are_separate, ["1.record-place"]),
    check!(basics::rows_are_overwritten_and_queried, ["1.row"]),
    check!(basics::a_place_has_facets_from_sources, ["1.facet"]),
    // Rules
    check!(rules::overview_lists_one_level, ["2.1", "1.level"]),
    check!(rules::listing_stops_at_the_limit_and_says_at_least, ["2.2"]),
    check!(rules::probe_stops_at_the_budget, ["2.2"]),
    check!(rules::count_stops_at_its_cap, ["2.2", "5.rows.where.input"]),
    check!(rules::look_at_a_dir_does_not_descend, ["2.1", "2.3"]),
    check!(
        rules::metadata_operations_do_not_read_bytes,
        ["2.4", "8.unreadable"]
    ),
    check!(rules::read_and_content_carry_the_token_they_read, ["2.6"]),
    check!(
        rules::noise_places_answer_noise,
        ["2.7", "1.noise", "8.noise"]
    ),
    check!(
        rules::noise_is_neither_listed_nor_entered,
        ["2.7", "1.noise"]
    ),
    check!(rules::deleting_the_cache_area_changes_no_answer, ["2.8"]),
    check!(rules::a_changed_directory_is_listed_again, ["2.8", "4.s2"]),
    check!(
        rules::every_answer_is_a_json_object_with_a_fixed_reason,
        ["2.10", "8.1", "8.2", "8.bad_request"]
    ),
    // Concurrency and interruption (2.9)
    check!(concurrency::two_writers_of_one_file, ["2.9.1", "2.5"]),
    check!(concurrency::two_writers_of_one_directory, ["2.9.1", "2.5"]),
    check!(concurrency::two_movers_onto_one_place, ["2.9.1", "2.5"]),
    check!(concurrency::two_removers_of_one_place, ["2.9.1", "2.5"]),
    check!(
        concurrency::two_putters_with_one_expected_cursor,
        ["2.9.1", "5.s5"]
    ),
    check!(concurrency::two_holders_of_one_place, ["2.9.1", "6.hold.1"]),
    check!(
        concurrency::a_serve_session_keeps_no_lock_after_a_write,
        ["2.9.1", "6.serve.1"]
    ),
    check!(
        concurrency::concurrent_appends_and_puts_lose_nothing,
        ["2.9.1", "5.s1"]
    ),
    check!(
        interruption::a_killed_directory_write_leaves_nothing,
        ["2.9.2"]
    ),
    check!(
        interruption::a_killed_directory_replacement_keeps_the_old,
        ["2.9.2"]
    ),
    check!(interruption::a_killed_stdin_write_leaves_nothing, ["2.9.2"]),
    check!(interruption::a_killed_removal_is_whole, ["2.9.2"]),
    check!(
        interruption::a_killed_move_onto_a_directory_is_whole,
        ["2.9.2"]
    ),
    check!(interruption::killed_moves_are_whole, ["2.9.2"]),
    check!(interruption::a_killed_append_leaves_no_half_file, ["2.9.2"]),
    check!(interruption::a_killed_rows_put_is_whole, ["2.9.2", "5.s5"]),
    check!(interruption::a_killed_hold_is_whole, ["2.9.2"]),
    // A place's description
    check!(places::descriptions_have_the_contract_shape, ["3.1", "3.2"]),
    check!(places::a_dir_size_is_its_entry_count, ["3.4"]),
    check!(places::facets_are_named_and_listed, ["3.5", "3.6"]),
    check!(
        places::facets_of_an_unreadable_dir_need_no_listing,
        ["3.8.1"]
    ),
    check!(
        places::placeholders_need_a_sync_service,
        ["3.8.2", "4.read.elsewhere", "7.placeholder", "8.elsewhere"]
    ),
    check!(places::costlier_facets_come_only_when_asked, ["3.9"]),
    // The content half
    check!(
        places::glance_describes_each_place_and_none_for_missing,
        ["4.glance.input", "4.glance.answer"]
    ),
    check!(
        places::overview_pages_with_more_after_and_defaults_to_200,
        ["4.overview.input", "4.overview.answer", "4.s2"]
    ),
    check!(
        places::probe_counts_files_dirs_and_bytes,
        ["4.probe.answer"]
    ),
    check!(
        places::probe_budget_defaults_to_500,
        ["4.probe.input", "2.2"]
    ),
    check!(
        places::look_answers_same_changed_and_gone,
        ["4.look.input", "4.look.answer", "3.11"]
    ),
    check!(
        places::overview_sorts_by_name_bytes_mixing_dirs_and_files,
        ["4.s1", "4.s2"]
    ),
    check!(places::overview_names_the_noise_it_left_out, ["4.s3"]),
    check!(
        places::probe_reports_top_level_markers,
        ["4.s4", "4.probe.answer"]
    ),
    check!(places::describe_lists_no_whole_library_operation, ["4.s11"]),
    check!(
        reads::changed_without_a_cursor_gives_the_current_one,
        ["4.changed.input"]
    ),
    check!(
        serial changes::changed_cannot_say_without_a_reliable_cursor,
        ["4.changed.answer", "8.cannot_say"]
    ),
    check!(
        serial changes::changed_reports_a_change_after_the_cursor,
        ["4.changed.answer", "4.s6", "2.3"]
    ),
    check!(serial changes::changed_stops_at_its_limit, ["2.2"]),
    check!(
        serial changes::changed_cannot_say_for_another_folder,
        ["4.changed.answer", "8.cannot_say"]
    ),
    check!(
        reads::file_content_is_fingerprint_token_size,
        ["4.content.file", "4.content.input", "1.content"]
    ),
    check!(
        reads::dir_content_is_manifest_fingerprint_files_token,
        ["4.content.dir", "4.content.input"]
    ),
    check!(
        reads::content_stops_at_its_file_limit,
        ["4.content.too-many", "8.too_many", "2.2"]
    ),
    check!(
        reads::content_sends_progress,
        ["4.content.progress", "6.serve.2"]
    ),
    check!(
        reads::content_rule_leaves_out_noise_and_ignored,
        ["4.s8", "4.s9", "4.write.input"]
    ),
    check!(
        reads::read_gives_bytes_and_token,
        ["4.read.input", "4.read.bytes"]
    ),
    check!(
        writes::write_places_bytes_from_a_path_or_stdin,
        ["4.write.input", "4.write.answer"]
    ),
    check!(
        writes::write_replaces_with_a_token,
        ["4.write.input", "4.write.answer"]
    ),
    check!(
        writes::write_of_a_directory_answers_its_content,
        ["4.write.answer"]
    ),
    check!(
        writes::write_refused_changes_nothing,
        ["2.5", "4.write.answer", "8.refused"]
    ),
    check!(
        writes::move_places_and_describes,
        ["4.move.input", "4.move.answer"]
    ),
    check!(
        writes::move_refused_changes_nothing,
        ["2.5", "4.move.answer", "8.refused"]
    ),
    check!(
        writes::remove_takes_it_away,
        ["4.remove.input", "4.remove.answer"]
    ),
    check!(
        writes::remove_refused_changes_nothing,
        ["2.5", "4.remove.answer", "8.refused"]
    ),
    check!(
        writes::remove_sends_progress,
        ["4.remove.progress", "6.serve.2"]
    ),
    // A record place's own area, and the sources of a write
    check!(
        areas::a_record_place_keeps_content_of_its_own,
        ["4.s12", "5.s10"]
    ),
    check!(areas::a_record_area_has_no_noise_and_no_holds, ["4.s13"]),
    check!(
        serial changes::a_record_area_is_never_reported_by_changed,
        ["4.s13"]
    ),
    check!(
        areas::the_facts_of_a_record_place_are_not_in_its_area,
        ["4.s14", "8.outside"]
    ),
    check!(areas::a_record_area_not_yet_written_reads_empty, ["4.s15"]),
    check!(areas::a_move_in_a_record_area_stays_in_it, ["4.s16"]),
    check!(
        areas::write_copies_between_the_content_and_a_record_place,
        ["4.s17", "4.s18", "4.write.input", "4.write.answer"]
    ),
    check!(areas::a_copy_onto_itself_is_a_bad_request, ["4.s19"]),
    check!(areas::a_bad_copy_source_names_its_side, ["4.s20"]),
    check!(
        areas::bytes_in_the_request_are_written,
        ["4.s21", "4.s22", "4.write.input"]
    ),
    check!(areas::names_storage_keeps_are_no_record_places, ["5.s12"]),
    // The record half
    check!(
        records::append_gives_one_order_per_fact,
        ["5.facts.append.input", "5.facts.append.answer", "1.fact"]
    ),
    check!(
        records::facts_since_gives_only_what_follows_the_cursor,
        ["5.facts.since.input", "5.facts.since.answer", "2.3", "2.2"]
    ),
    check!(records::facts_are_only_appended, ["5.s1", "1.fact"]),
    check!(records::facts_travel_with_the_folder, ["5.s1"]),
    check!(
        records::limit_zero_gives_a_cursor_at_the_end,
        ["5.facts.since.answer"]
    ),
    check!(
        records::the_cursor_at_the_end_is_the_same_while_nothing_changes,
        ["5.facts.since.answer"]
    ),
    check!(
        records::a_cursor_that_no_longer_fits_is_refused,
        ["5.facts.since.answer"]
    ),
    check!(
        records::facts_since_with_nothing_new_survives_an_unreadable_old_day,
        ["5.facts.since.cost", "5.s2"]
    ),
    check!(
        records::each_append_is_its_own_file_under_its_day,
        ["5.s1", "5.s2"]
    ),
    check!(records::the_old_layout_is_still_read, ["5.s2"]),
    check!(records::a_late_linked_file_is_still_given, ["5.s1", "5.s2"]),
    check!(
        records::rows_put_then_get_round_trips,
        [
            "5.rows.put.input",
            "5.rows.put.answer",
            "5.rows.get.input",
            "5.rows.get.answer"
        ]
    ),
    check!(
        records::rows_under_pages_by_prefix,
        ["5.rows.under.input", "5.rows.under.answer", "2.2"]
    ),
    check!(
        records::rows_where_pages_and_counts,
        ["5.rows.where.input", "5.rows.where.answer"]
    ),
    check!(
        records::rows_reset_drops_rows_and_cursor,
        ["5.rows.reset.question", "5.rows.reset.answer"]
    ),
    check!(
        records::rows_are_a_cache_that_can_be_deleted,
        ["5.s3", "2.8"]
    ),
    check!(
        records::rows_put_with_a_wrong_expectation_changes_nothing,
        ["2.5", "5.s5", "8.refused"]
    ),
    check!(records::rows_and_cursor_change_in_one_commit, ["5.s5"]),
    check!(records::fields_are_at_most_four_strings_per_table, ["5.s6"]),
    check!(records::there_is_no_query_operation, ["5.s8"]),
    // Other operations
    check!(others::init_makes_the_areas_once, ["6.init.1", "6.init.2"]),
    check!(
        others::describe_says_what_the_provider_is,
        ["6.describe.1", "0.5"]
    ),
    check!(
        others::noise_is_listed_added_and_removed,
        ["6.noise", "1.noise"]
    ),
    check!(others::holds_block_other_writers, ["6.hold.1", "8.held"]),
    check!(others::held_places_are_marked, ["6.hold.2"]),
    check!(
        others::one_hold_covers_several_places,
        ["6.hold.4", "8.held"]
    ),
    check!(
        others::the_declaration_is_kept_whole,
        ["6.declaration.1", "1.storage"]
    ),
    check!(others::no_declaration_reads_null, ["6.declaration.2"]),
    check!(
        others::a_declaration_write_holds_to_its_expectation,
        ["6.declaration.3", "2.5", "2.9.1", "8.refused"]
    ),
    check!(
        others::the_noise_list_is_apart_from_the_declaration,
        ["6.declaration.4"]
    ),
    check!(serial others::a_hold_expires, ["6.hold.1", "6.hold.2"]),
    check!(others::serve_echoes_ids, ["6.serve.1"]),
    check!(others::serve_cancels_by_id, ["6.serve.3", "8.cancelled"]),
    check!(
        others::a_cancelled_write_places_nothing,
        ["6.serve.3", "2.9.2", "8.cancelled"]
    ),
    // The local folder's facets and token
    check!(local::the_fs_facet_is_always_there, ["7.fs"]),
    check!(local::the_macos_facet_reads_its_attributes, ["7.macos"]),
    check!(
        local::the_token_moves_with_size_mtime_ctime_and_inode,
        ["7.token.1", "3.12"]
    ),
    check!(local::a_racy_same_size_edit_is_seen, ["7.racy"]),
    check!(
        local::a_written_token_is_same_until_a_change,
        ["7.racy", "4.write.answer"]
    ),
    // Failures
    check!(
        failures::listing_a_missing_or_file_place_fails,
        ["8.no_such_place", "8.not_a_dir"]
    ),
    check!(failures::reading_a_dir_is_not_a_file, ["8.not_a_file"]),
    check!(
        failures::places_below_a_link_or_in_the_record_area_are_outside,
        ["8.outside"]
    ),
    check!(
        failures::an_unreadable_dir_does_not_stop_the_rest,
        ["8.unreadable"]
    ),
];
