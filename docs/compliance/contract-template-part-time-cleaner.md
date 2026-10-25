# Part-Time Cleaning Operative — Employment Contract (template for the CRM)

Drafted 20 October 2026 for Contracts → Templates. It is an **employment** contract, not a contractor agreement: use it where the cleaner works hours you set, under your direction, with your equipment and materials. If she genuinely runs her own cleaning business, invoices you and can send a substitute, that is a services agreement and a different document (Revenue's Karshan test, Supreme Court 2023). This draft follows the Acts named in the WRC letter and the Terms of Employment (Information) Act 1994 as amended by the Transparent and Predictable Working Conditions Regulations 2022, and should go to your solicitor for sign-off like the handbook.

## Set-up in the CRM

- **Name:** Part-Time Cleaning Operative Employment Contract
- **Employment type:** FTE only (the wizard then fills `hourly_rate`, `contracted_hours_per_week` and `overtime_rate` from the staff record; put the cleaner's hourly rate and weekly hours on her staff profile first).
- **Built-in placeholders used:** `full_name`, `email`, `legal_entity_name`, `location_name`, `location_address`, `hourly_rate`, `contracted_hours_per_week`, `today`.
- **Custom variables to add on the template form:**

| key | label | type | required | default |
|---|---|---|---|---|
| `start_date` | Commencement date | date | yes | |
| `employee_address` | Employee's home address | text | yes | |
| `job_title` | Job title | text | yes | Cleaning Operative |
| `working_pattern` | Usual days and hours | text | yes | Monday to Friday, 06:00 to 08:00 |
| `pay_day` | Pay frequency and day | text | yes | Monthly in arrears, on the last working day of each month |
| `sunday_premium` | Sunday premium | text | yes | an additional one-third of the hourly rate for each hour worked on a Sunday |
| `probation_months` | Probation (months) | number | yes | 6 |
| `annual_leave_weeks` | Annual leave (working weeks per year, pro rata) | number | yes | 4 |

Everything below the line is the **Body**. Paste it as-is.

---

# EMPLOYMENT CONTRACT

THIS EMPLOYMENT CONTRACT (the "Agreement") is dated {{today}}.

**BETWEEN:**

**EMPLOYER:** {{legal_entity_name}}, {{location_address}} (the "Employer" or the "Company")

**AND**

**EMPLOYEE:** {{full_name}}, of {{employee_address}} (the "Employee")

This Agreement, together with the Employee Handbook, sets out the written statement of the terms of employment required by the Terms of Employment (Information) Act 1994 (as amended) and the European Union (Transparent and Predictable Working Conditions) Regulations 2022. Where this Agreement and the Handbook differ, this Agreement prevails.

## 1. Commencement and continuity

1.1 The Employee's employment begins on {{start_date}} (the "Commencement Date"). No previous employment counts towards continuous service.

1.2 The employment is permanent and part-time. It is not for a fixed term or a specified purpose.

## 2. Job title and duties

2.1 The Employee is employed as {{job_title}}.

2.2 The duties are the cleaning and upkeep of the premises at {{location_name}}: studio floors, changing rooms, showers, toilets, reception and office areas, equipment surfaces and touch points, waste removal, restocking of consumables, and the recording of completed tasks on the cleaning checklist provided. The Employee will follow the Company's cleaning schedule, product instructions and safety procedures, and will report any damage, hazard, spillage or shortage of supplies to the manager on duty.

2.3 The Employee will carry out other reasonable duties consistent with the role as the Company may ask from time to time, and will comply with the Company's rules, policies and procedures as adopted or changed from time to time.

## 3. Place of work

3.1 The Employee's place of work is {{location_name}}, {{location_address}}.

3.2 The Company may ask the Employee to work at another premises operated by the Company within reasonable travelling distance, on reasonable notice. Travel time between two Company premises during a working day counts as working time.

## 4. Hours of work

4.1 The Employee's contracted hours are {{contracted_hours_per_week}} hours per week. The usual working pattern is {{working_pattern}}. The Company will give at least one week's notice of any change to the usual pattern, except where cover is needed at short notice and the Employee agrees.

4.2 The contracted hours in clause 4.1 are guaranteed hours. This Agreement is not a zero-hours contract. Where the Employee is asked to attend for work and is sent home without work, the Employee will be paid as provided by section 18 of the Organisation of Working Time Act 1997.

4.3 After 12 months' service the Employee may ask in writing to be placed in a band of weekly hours that reflects the hours actually worked over the previous 12 months, as provided by section 18A of the Organisation of Working Time Act 1997.

4.4 The Employee is not required to work beyond the contracted hours. Additional hours offered by the Company and accepted by the Employee are paid at the hourly rate in clause 5, with the Sunday premium in clause 5.3 where they fall on a Sunday.

4.5 The Company complies with the Organisation of Working Time Act 1997: a maximum average of 48 working hours per week over a 4-month reference period, a daily rest of 11 consecutive hours, a weekly rest of 24 consecutive hours, a 15-minute break after 4.5 hours worked and a 30-minute break after 6 hours worked. Breaks are unpaid unless the Company says otherwise.

4.6 The Employee will record start and finish times and breaks accurately in the Company's rostering and attendance system.

## 5. Pay

5.1 The Employee is paid at the rate of {{hourly_rate}} per hour worked. The rate will never be less than the National Minimum Wage applicable to the Employee under the National Minimum Wage Act 2000, and the Company will increase it where that Act requires. The pay reference period for the purposes of that Act is one calendar month.

5.2 Pay is calculated on hours worked and is paid {{pay_day}}, by credit transfer to a bank account nominated by the Employee. The Employee will receive a written or electronic payslip with each payment showing gross pay, each deduction and net pay, as required by the Payment of Wages Act 1991.

5.3 Sunday work. For each hour worked on a Sunday the Employee receives {{sunday_premium}}, in satisfaction of section 14 of the Organisation of Working Time Act 1997.

5.4 Public holidays. The Employee's entitlement in respect of each of the public holidays is determined under section 21 of the Organisation of Working Time Act 1997. Where the Employee has worked at least 40 hours in the 5 weeks before the public holiday, the Employee will receive, at the Company's choice and communicated in advance, a paid day off on the day, a paid day off within a month, an additional day's annual leave or an additional day's pay, calculated under the Organisation of Working Time (Determination of Pay for Holidays) Regulations 1997.

5.5 Deductions. The Company may deduct from pay the statutory deductions (PAYE, PRSI and USC) and any amount the Employee has agreed to in writing in advance. The Employee consents to the deduction of the cost of Company property (keys, fobs, uniform) that is lost or not returned on termination, and of any overpayment of wages, in each case after the Company has given written notice of the amount and the reason and the Employee has had an opportunity to respond. No deduction will reduce pay below the National Minimum Wage for the hours worked.

5.6 The Company does not operate a collective agreement and no registered employment agreement or sectoral employment order applies to this employment. Should the Contract Cleaning Joint Labour Committee's Employment Regulation Order be found to apply to the Employee's work, its minimum rates and conditions will apply in place of any less favourable term here.

## 6. Part-time status

The Employee will not be treated less favourably than a comparable full-time employee in respect of conditions of employment solely because the Employee works part-time, in accordance with the Protection of Employees (Part-Time Work) Act 2001. Entitlements calculated by reference to hours worked are applied pro rata.

## 7. Probation

7.1 The first {{probation_months}} months of employment are a probationary period, during which the Company assesses the Employee's suitability. The Company may extend probation by up to 3 further months where there are reasonable grounds, in accordance with the Probationary Periods (Employee Information) Act 2022, and the total period will not exceed 12 months.

7.2 During probation either party may end the employment on the statutory minimum notice in clause 14. The Company will confirm in writing when probation has been completed.

## 8. Annual leave

8.1 The leave year runs from 1 January to 31 December. The Employee is entitled to paid annual leave of {{annual_leave_weeks}} working weeks per leave year, pro rata for part-time hours, and in any event not less than the greatest of the three entitlements in section 19(1) of the Organisation of Working Time Act 1997: 4 working weeks where at least 1,365 hours are worked in the leave year, one third of a working week for each month in which at least 117 hours are worked, or 8 per cent of the hours worked in the leave year, up to a maximum of 4 working weeks.

8.2 Leave is taken at times agreed with the manager, having regard to the needs of the business and the Employee's need for rest and recreation. The Employee will give at least 2 weeks' notice of a request for leave of 3 days or more.

8.3 Holiday pay is calculated under the Organisation of Working Time (Determination of Pay for Holidays) Regulations 1997 on the Employee's normal weekly pay averaged over the 13 weeks before the leave. On termination the Company will pay for any accrued leave not taken.

## 9. Sick leave and sick pay

9.1 If the Employee cannot attend work because of illness or injury the Employee will tell the manager on duty by telephone as early as possible before the shift, and will follow the absence procedure in the Employee Handbook, including the supply of a medical certificate where required.

9.2 The Employee is entitled to statutory sick leave under the Sick Leave Act 2022, paid at the statutory daily rate for the statutory number of certified days per year as in force from time to time, after 13 weeks' continuous service and on production of a certificate from a registered medical practitioner. The Company does not operate a company sick-pay scheme in addition to statutory sick leave.

## 10. Other statutory leave

The Employee is entitled to maternity, paternity, parent's, adoptive, parental, carer's, force majeure, domestic-violence and medical-care leave, and to time off for jury service, on the conditions set out in the relevant legislation, as summarised in the Employee Handbook.

## 11. Pension

The Company participates in the automatic enrolment retirement savings system ("My Future Fund") under the Automatic Enrolment Retirement Savings System Act 2024. Where the Employee meets the eligibility conditions the Employee will be enrolled automatically and the Employee and the Company will each contribute at the statutory rates. The Employee may opt out in accordance with the Act. No occupational pension scheme operates.

## 12. Health, safety and welfare

12.1 The Company will, so far as is reasonably practicable, provide a safe place and system of work, safe cleaning products and equipment, instruction in their use, and personal protective equipment (gloves, eye protection and footwear where required) at no cost to the Employee, in accordance with the Safety, Health and Welfare at Work Act 2005 and the Chemical Agents Regulations.

12.2 The Employee will complete the Company's induction, manual-handling and chemical-safety training before starting work alone, use the products and equipment only as instructed and in accordance with the safety data sheets, wear the protective equipment provided, never mix cleaning chemicals, store products in the designated locked area, and report accidents, near misses and hazards to the manager at once.

12.3 Where the Employee works alone on the premises outside opening hours, the Employee will follow the lone-working procedure, keep the entrance secured, and carry a charged phone with the manager's contact number.

12.4 The Employee will tell the Company of any medical condition, pregnancy or allergy that may affect safe working with cleaning products so that a risk assessment and any reasonable accommodation can be made.

## 13. Right to work

The Employee confirms that the Employee is entitled to work in Ireland and will provide evidence of that entitlement (a passport and, where applicable, an immigration permission or employment permit) before the Commencement Date, and will tell the Company at once of any change. The Company is obliged under the Employment Permits Acts to keep copies of that evidence.

## 14. Notice and termination

14.1 After 13 weeks' continuous service, the Company will give the Employee the minimum notice required by the Minimum Notice and Terms of Employment Act 1973 (one week for service of 13 weeks to 2 years, two weeks for 2 to 5 years, and so on as that Act provides), or pay in lieu. The Employee will give the Company one week's notice in writing.

14.2 The Company may dismiss the Employee without notice for gross misconduct, following the disciplinary procedure in the Employee Handbook.

14.3 On termination the Employee will return all keys, fobs, uniform, equipment and other Company property, and the Company will pay any accrued but untaken annual leave.

14.4 The Employee's statutory rights, including under the Unfair Dismissals Acts 1977 to 2015 after one year's continuous service, are not affected by this clause.

## 15. Discipline and grievances

The Company's disciplinary, grievance and dignity-at-work procedures are in the Employee Handbook. They follow the Code of Practice on Grievance and Disciplinary Procedures (S.I. 146 of 2000). The Employee may be accompanied by a colleague or trade union representative at any formal meeting.

## 16. Confidentiality and data protection

16.1 In the course of the work the Employee may see members' personal belongings, documents, health information and other personal data, and the Company's commercial information. The Employee will keep all such information confidential during and after employment, will not photograph or copy it, and will hand any found property or document to the manager.

16.2 The Company processes the Employee's personal data for the purposes of the employment as described in the Staff Privacy Notice. The premises are monitored by CCTV for the security of staff, members and property, as set out in that Notice.

## 17. Conduct

The Employee will attend punctually for each rostered shift in the uniform or clothing provided, will not consume alcohol or intoxicants before or during work, will not smoke or vape on the premises, and will treat members, colleagues and visitors with courtesy. Members' training areas are to be cleaned only at the times set out in the cleaning schedule or as the manager directs, so that classes are not disrupted.

## 18. Changes to terms

The Company will notify the Employee in writing of any change to the terms set out in this Agreement not later than the day on which the change takes effect, as required by the Terms of Employment (Information) Act 1994. No change to pay, hours or place of work will be made without the Employee's agreement, except where required by law.

## 19. Training

The Company will provide any training it requires the Employee to undertake free of charge and, where possible, during working hours, with the time counted as working time.

## 20. Entire agreement and governing law

20.1 This Agreement and the Employee Handbook contain the whole agreement between the parties on the employment and replace any earlier arrangement.

20.2 This Agreement is governed by the laws of Ireland. The Employee may refer any dispute about the Employee's statutory rights to the Workplace Relations Commission.

## Signatures

Signed for and on behalf of {{legal_entity_name}}: see the issuer's countersignature recorded on this contract.

Signed by the Employee: {{full_name}}, {{email}}, by electronic signature recorded on this contract. By signing, the Employee confirms receipt of this statement of terms and of the Employee Handbook, the Staff Privacy Notice and the Acceptable Use Policy.
