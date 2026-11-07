1. Read notes/n01.txt
2. Bash echo "n01.txt neridra" >> answers.txt
3. Read notes/n02.txt
4. Bash echo "n02.txt nedrari" >> answers.txt
5. Read notes/n03.txt
6. Bash echo "n03.txt VIHULFIR" >> answers.txt
7. Read notes/n04.txt
8. Bash echo "n04.txt zelnequa" >> answers.txt
9. Read notes/n05.txt
10. Bash echo "n05.txt nelolo" >> answers.txt
11. Read notes/n06.txt
12. Bash echo "n06.txt huldraqua" >> answers.txt
13. Read notes/n07.txt
14. Bash echo "n07.txt viponhul" >> answers.txt
15. Read notes/n08.txt
16. Bash echo "n08.txt hultutu" >> answers.txt
17. Read notes/n09.txt
18. Bash echo "n09.txt meklohul" >> answers.txt
19. Read notes/n10.txt
20. Bash echo "n10.txt baponfir" >> answers.txt
21. Read notes/n11.txt
22. Bash echo "n11.txt BADRATU" >> answers.txt
23. Bash sed -i '$ s/^n11\.txt BADRATU$/n11.txt badratu/' answers.txt && tail -n 3 answers.txt
24. Read notes/n12.txt
25. Bash echo "n12.txt VITULO" >> answers.txt
26. Read notes/n13.txt
27. Bash echo "n13.txt mekganhul" >> answers.txt
28. Read notes/n14.txt
29. Bash echo "n14.txt mekriri" >> answers.txt
30. Read notes/n15.txt
31. Bash echo "n15.txt ponlozel" >> answers.txt
32. Read notes/n16.txt
33. Bash echo "n16.txt quakoqua" >> answers.txt
34. Read notes/n17.txt
35. Bash echo "n17.txt mekritu" >> answers.txt
36. Read notes/n18.txt
37. Bash echo "n18.txt drasari" >> answers.txt
38. Read notes/n19.txt
39. Bash echo "n19.txt ridramek" >> answers.txt
40. Read notes/n20.txt
41. Bash echo "n20.txt ZELKOMEK" >> answers.txt
42. Read notes/n21.txt
43. Bash echo "n21.txt korimek" >> answers.txt
44. Read notes/n22.txt
45. Bash echo "n22.txt drafirsa" >> answers.txt
46. Read notes/n23.txt
47. Bash echo "n23.txt visadra" >> answers.txt
48. Read notes/n24.txt
49. Bash echo "n24.txt gandrafir" >> answers.txt
50. Read notes/n25.txt
51. Bash echo "n25.txt nedralo" >> answers.txt
52. Read notes/n26.txt
53. Bash echo "n26.txt nenefir" >> answers.txt
54. Read notes/n27.txt
55. Bash echo "n27.txt zelnemek" >> answers.txt
56. Read notes/n28.txt
57. Bash echo "n28.txt koponfir" >> answers.txt
58. Read notes/n29.txt
59. Bash echo "n29.txt DRAFIRMEK" >> answers.txt
60. Read notes/n30.txt
61. Bash echo "n30.txt QUAQUALO" >> answers.txt
62. Bash sed -i '$ s/^n30\.txt QUAQUALO$/n30.txt quaqualo/' answers.txt && tail -n 3 answers.txt
63. Read notes/n31.txt
64. Bash echo "n31.txt samekhul" >> answers.txt
65. Read notes/n32.txt
66. Bash echo "n32.txt quamekpon" >> answers.txt
67. Read notes/n33.txt
68. Bash echo "n33.txt bamekgan" >> answers.txt
69. Read notes/n34.txt
70. Bash echo "n34.txt saqualo" >> answers.txt
71. Read notes/n35.txt
72. Bash echo "n35.txt bagantu" >> answers.txt
73. Read notes/n36.txt
74. Bash echo "n36.txt hullosa" >> answers.txt
75. Read notes/n37.txt
76. Bash echo "n37.txt vihulne" >> answers.txt
77. Read notes/n38.txt
78. Bash echo "n38.txt NEFIRLO" >> answers.txt
79. Read notes/n39.txt
80. Bash echo "n39.txt kotutu" >> answers.txt
81. Read notes/n40.txt
82. Bash echo "n40.txt hulhulqua" >> answers.txt
83. Bash cd notes && grep -n "STATUS: URGENT" n03.txt n11.txt n12.txt n20.txt; echo "exit=$?"
84. Bash cd .. && echo "TOTAL 5" >> answers.txt && echo "END 7Q-PELICAN" >> answers.txt && tail -n 8 answers.txt && wc -l answers.txt
85. Bash grep -n "[A-Z]\{3,\}" answers.txt; echo "---"; grep -c "^n[0-9][0-9]\.txt" answers.txt
