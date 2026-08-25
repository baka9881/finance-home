from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal

from app.services import (
    _is_detected_recurring_group,
    _recurring_detection_signature,
)


def recurring_group(
    name: str,
    category: str,
    occurrences: list[tuple[date, str]],
    *,
    loan: bool = False,
) -> dict:
    months = defaultdict(lambda: {"amount": Decimal("0"), "count": 0, "dates": []})
    for occurred_on, amount in occurrences:
        month = occurred_on.strftime("%Y-%m")
        months[month]["amount"] += Decimal(amount)
        months[month]["count"] += 1
        months[month]["dates"].append(occurred_on)
    return {
        "name": name,
        "months": months,
        "categories": {category: len(occurrences)},
        "has_loan_principal": loan,
    }


def test_explicit_subscription_can_be_detected_after_two_months():
    group = recurring_group(
        "OPENAI *CHATGPT SUBSCR",
        "訂閱",
        [(date(2026, 7, 12), "539"), (date(2026, 8, 12), "545")],
    )
    assert _is_detected_recurring_group(group) is True


def test_known_subscription_allows_one_missing_month():
    group = recurring_group(
        "OPENAI *CHATGPT SUBSCR",
        "訂閱",
        [(date(2026, 6, 15), "539"), (date(2026, 8, 15), "539")],
    )
    assert _is_detected_recurring_group(group) is True


def test_known_subscription_does_not_allow_a_wider_gap():
    group = recurring_group(
        "OPENAI *CHATGPT SUBSCR",
        "訂閱",
        [(date(2026, 5, 15), "539"), (date(2026, 8, 15), "539")],
    )
    assert _is_detected_recurring_group(group) is False


def test_variable_merchants_are_not_fixed_expenses_even_when_repeated():
    for name, category in (
        ("樂購蝦皮股份有限公司", "購物"),
        ("全家便利商店-烏日火車頭店", "餐飲"),
        ("高鐵智慧型手機 iPhone", "交通"),
        ("休閒用品", "未分類"),
    ):
        group = recurring_group(
            name,
            category,
            [
                (date(2026, 6, 8), "500"),
                (date(2026, 7, 8), "500"),
                (date(2026, 8, 8), "500"),
            ],
        )
        assert _is_detected_recurring_group(group) is False


def test_generic_bill_requires_three_consecutive_stable_months():
    two_months = recurring_group(
        "社區管理委員會",
        "居住",
        [(date(2026, 7, 5), "2000"), (date(2026, 8, 5), "2000")],
    )
    assert _is_detected_recurring_group(two_months) is False

    three_months = recurring_group(
        "社區管理委員會",
        "居住",
        [
            (date(2026, 6, 5), "2000"),
            (date(2026, 7, 5), "2000"),
            (date(2026, 8, 7), "2020"),
        ],
    )
    assert _is_detected_recurring_group(three_months) is True


def test_similar_railway_statement_names_share_a_detection_signature():
    assert _recurring_detection_signature("國營臺灣鐵路公司網路購") == (
        _recurring_detection_signature("國營臺灣鐵路公司網路購票")
    )
